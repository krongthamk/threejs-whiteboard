import { assertValidElement, contentBounds, deriveElementGeometry, importExcalidraw, isImportPlanCurrent, MAX_EXCALIDRAW_BYTES,
  planImport, readImageHeader, type Binding, type BoardDocument, type Box, type Element, type ExcalidrawImport, type ImportBudget } from '@whiteboard/model';
import { api } from './api';
import { normalizeImagePixels } from './image-orientation';
import type { ImportLease, ImportTransport } from './import-transport';
import type { SessionStore } from './session';

export type ImportReport = ExcalidrawImport['report'] & {
  acknowledged: number;
  batches: number;
  pending: number;
  message?: string;
}
export interface ExcalidrawImportOptions {
  board: BoardDocument; boardId: string; canvas: HTMLCanvasElement; session: SessionStore;
  transport?: ImportTransport; isReadOnly(): boolean; maxImageDimension(): number;
  onReport?(report: ImportReport): void;
}
export function isExcalidrawText(text: string): boolean {
  return /^\s*\{/.test(text) && /"type"\s*:\s*"excalidraw(?:\/clipboard)?"/.test(text);
}
export function parseExcalidrawSource(text: string, originalBytes?: number): unknown {
  if ((originalBytes ?? 0) > MAX_EXCALIDRAW_BYTES || text.length > MAX_EXCALIDRAW_BYTES || new TextEncoder().encode(text).length > MAX_EXCALIDRAW_BYTES) throw new Error('The Excalidraw source exceeds the 50 MiB limit.');
  try { return JSON.parse(text); } catch { throw new Error('The Excalidraw file is not valid JSON.'); }
}

/** Move only a wholly offscreen import. Stroke triples and connector fallback points are world coordinates. */
export function placeImportedElements(source: readonly Element[], viewport: Box): Element[] {
  if (!source.length) return [];
  const bounds = contentBounds(source);
  const offscreen = bounds.x + bounds.w < viewport.x || bounds.y + bounds.h < viewport.y || bounds.x > viewport.x + viewport.w || bounds.y > viewport.y + viewport.h;
  const dx = offscreen ? viewport.x + 40 - bounds.x : 0, dy = offscreen ? viewport.y + 40 - bounds.y : 0;
  return source.map(original => {
    let element = structuredClone(original);
    element.x += dx; element.y += dy;
    if (element.type === 'stroke') element = deriveElementGeometry({ ...element, props: { ...element.props,
      points: element.props.points.map((n, i) => i % 3 === 0 ? n + dx : i % 3 === 1 ? n + dy : n) } });
    if (element.type === 'connector') {
      const move = (b: Binding): Binding => 'elementId' in b ? { ...b, fallback: { x: b.fallback.x + dx, y: b.fallback.y + dy } } : { x: b.x + dx, y: b.y + dy };
      element = { ...element, props: { ...element.props, start: move(element.props.start), end: move(element.props.end) } };
    }
    assertValidElement(element); return element;
  });
}
function freshDestinationIds(board: BoardDocument, input: readonly Element[]): Element[] {
  const occupied = new Set(input.map(e => e.id)), replacements = new Map<string, string>();
  for (const element of input) if (board.base(element.id)) {
    let id: string; do { id = crypto.randomUUID(); } while (board.base(id) || occupied.has(id));
    replacements.set(element.id, id); occupied.add(id);
  }
  return input.map(source => {
    let element = structuredClone(source); element.id = replacements.get(element.id) ?? element.id;
    if (element.type === 'connector') {
      const remap = (b: Binding): Binding => 'elementId' in b ? { ...b, elementId: replacements.get(b.elementId) ?? b.elementId } : b;
      element = { ...element, props: { ...element.props, start: remap(element.props.start), end: remap(element.props.end) } };
    }
    return element;
  });
}
const reserve = (budget: ImportBudget) => Math.min(4096, Math.floor(budget.maxInboundBytes / 4));
/** Browser preparation plus exact, synchronous first-batch replay. Earlier acknowledged batches are never rolled back. */
export class ExcalidrawImporter {
  private active: AbortController | undefined;
  private stopped = false;
  constructor(private readonly options: ExcalidrawImportOptions) {}
  destroy(): void { this.stopped = true; this.active?.abort(new Error('The board closed during import.')); }
  private writable(signal: AbortSignal): void {
    signal.throwIfAborted();
    if (this.stopped || this.options.isReadOnly()) throw new Error('This board is read-only or closed.');
  }
  private viewport(): Box {
    const rect = this.options.canvas.getBoundingClientRect(), camera = this.options.session.getState().camera;
    return { x: camera.x - rect.width / camera.zoom / 2, y: camera.y - rect.height / camera.zoom / 2, w: rect.width / camera.zoom, h: rect.height / camera.zoom };
  }
  private select(ids: readonly string[]): void {
    const elements = ids.flatMap(id => { const e = this.options.board.read(id); return e ? [e] : []; });
    if (!elements.length || this.stopped) return;
    const bounds = contentBounds(elements), rect = this.options.canvas.getBoundingClientRect();
    const zoom = Math.min(1, Math.max(.02, Math.min(Math.max(1, rect.width - 160) / Math.max(1, bounds.w), Math.max(1, rect.height - 180) / Math.max(1, bounds.h))));
    this.options.session.setState({ selectedIds: elements.map(e => e.id), tool: 'select', camera: { x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2, zoom } });
  }
  async importText(text: string, originalBytes?: number): Promise<void> {
    if (this.active) throw new Error('Wait for the current import to finish.');
    const controller = new AbortController(); this.active = controller;
    const timeout = setTimeout(() => controller.abort(new Error('The import timed out. Retry after checking the connection.')), 120_000);
    let lease: ImportLease | undefined, report: ImportReport | undefined;
    const localIds: string[] = [];
    try {
      this.writable(controller.signal);
      const json = parseExcalidrawSource(text, originalBytes);
      const converted = importExcalidraw(json, { newId: () => crypto.randomUUID(), firstIndex: this.options.board.highestIndex() });
      report = { ...converted.report, imported: 0, acknowledged: 0, batches: 0, pending: 0 };
      if (!converted.elements.length) { this.options.onReport?.(report); return; }
      if (!this.options.transport) throw new Error('Connect to a board before importing Excalidraw files.');
      lease = this.options.transport.beginImport(controller.signal);
      const signal = lease.signal;
      // Preflight final image dimensions and a maximal fixed-length server asset ID before any upload.
      let elements = converted.elements.map(e => e.type === 'image' ? { ...e, props: { ...e.props, assetId: '00000000-0000-4000-8000-000000000000' } } : e);
      const imageLimit = this.options.maxImageDimension();
      if (converted.images.length && (!Number.isInteger(imageLimit) || imageLimit < 1)) throw new Error('The renderer image limit is unavailable. Try again after the canvas is ready.');
      for (const image of converted.images) {
        const crop = image.transform?.crop;
        const width = crop ? Math.max(1, Math.ceil(crop.width)) : image.naturalW, height = crop ? Math.max(1, Math.ceil(crop.height)) : image.naturalH;
        if (width > imageLimit || height > imageLimit) throw new Error('An imported image exceeds this device’s texture limit.');
        elements = elements.map(e => e.id === image.elementId && e.type === 'image' ? { ...e, props: { ...e.props, naturalW: width, naturalH: height } } : e);
      }
      let budget = await lease.budget(); this.writable(signal);
      elements = freshDestinationIds(this.options.board, elements);
      // Preserve image lookup before refreshing collisions after later awaits.
      const imageIds = new Map(converted.elements.map((e, i) => [e.id, elements[i]!.id]));
      planImport(this.options.board, placeImportedElements(freshDestinationIds(this.options.board, elements), this.viewport()), { documentName: this.options.boardId, budget, inboundReserveBytes: reserve(budget) });
      const prepared = new Map<string, { blob: Blob; width: number; height: number; key: string }>();
      for (const image of converted.images) {
        this.writable(signal);
        const bytes = Uint8Array.from(image.bytes), header = readImageHeader(bytes);
        const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
        const key = digest + ':' + JSON.stringify(image.transform ?? null);
        const reused = [...prepared.values()].find(p => p.key === key);
        if (reused) { prepared.set(imageIds.get(image.elementId)!, reused); continue; }
        const blob = await normalizeImagePixels(new Blob([bytes], { type: header.mimeType }), header, signal, image.transform);
        this.writable(signal);
        const result = readImageHeader(new Uint8Array(await blob.arrayBuffer()));
        prepared.set(imageIds.get(image.elementId)!, { blob, width: result.width, height: result.height, key });
      }
      // Recheck predictable admission after pixel work, before the first upload.
      budget = await lease.budget(); this.writable(signal);
      planImport(this.options.board, placeImportedElements(freshDestinationIds(this.options.board, elements), this.viewport()), { documentName: this.options.boardId, budget, inboundReserveBytes: reserve(budget) });
      const uploaded = new Map<string, string>();
      for (const [id, image] of prepared) {
        this.writable(signal);
        let assetId = uploaded.get(image.key);
        if (!assetId) {
          const asset = await api.uploadAsset(this.options.boardId, image.blob, signal); this.writable(signal);
          if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(asset.assetId) || asset.width !== image.width || asset.height !== image.height) throw new Error('The server returned inconsistent imported image metadata.');
          uploaded.set(image.key, asset.assetId); assetId = asset.assetId;
        }
        elements = elements.map(e => e.id === id && e.type === 'image' ? { ...e, props: { ...e.props, assetId: assetId! } } : e);
      }
      elements = placeImportedElements(elements, this.viewport());
      while (elements.length) {
        this.writable(signal);
        budget = await lease.budget(); this.writable(signal);
        if (localIds.length && elements.some(e => this.options.board.base(e.id))) throw new Error('An import ID was added by another writer. The remaining import stopped; earlier batches remain.');
        if (!localIds.length) elements = freshDestinationIds(this.options.board, elements);
        const plan = planImport(this.options.board, elements, { documentName: this.options.boardId, budget, inboundReserveBytes: reserve(budget) });
        lease.assertReady();
        if (!isImportPlanCurrent(this.options.board, plan)) throw new Error('The board changed during import preflight. Try again.');
        const batch = plan.batches[0]!;
        // No awaits here: replay validated element additions using the real writer and UndoManager.
        this.options.board.transact(() => { for (const element of batch.elements) this.options.board.add(element); });
        localIds.push(...batch.elements.map(e => e.id)); report.imported += batch.elements.length; report.pending = batch.elements.length; report.batches++;
        this.select(localIds); this.options.onReport?.({ ...report });
        await lease.waitAcknowledged();
        report.acknowledged += batch.elements.length; report.pending = 0;
        elements = elements.slice(batch.elements.length);
      }
      this.options.onReport?.({ ...report });
    } catch (error) {
      if (report) {
        report.message = error instanceof Error ? error.message : 'The import stopped.';
        report.imported = localIds.filter(id => !!this.options.board.read(id)).length;
        report.pending = Math.max(0, report.imported - report.acknowledged);
        this.select(localIds); if (!this.stopped) this.options.onReport?.({ ...report });
      }
      throw error;
    } finally { clearTimeout(timeout); lease?.release(); this.active = undefined; }
  }
}
