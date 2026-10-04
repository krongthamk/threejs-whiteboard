import { normalizeImageOrientation } from './image-orientation';
import { readImageHeader, MAX_IMAGE_BYTES, contentBounds, documentToSvg, resolveBinding, resolveFontRuns, type BoardDocument, type Box, type Element } from '@whiteboard/model';
import { createRenderer, ExportContextLostError, waitForSignal, IMAGE_ERROR_COLOR, type ThreeRenderer } from '@whiteboard/renderer';

export interface ExportOptions { format: 'png' | 'svg' | 'pdf'; selection?: readonly string[]; scale: number; transparent: boolean; title: string; padding?: number; signal?: AbortSignal; onAssetWarnings?: (assetIds: readonly string[]) => void }
export interface ExportSnapshot { elements: Element[]; bounds: Box }
const faces = [
  { family: 'Inter', stem: 'inter-latin-400-normal' },
  { family: 'IBM Plex Mono', stem: 'ibm-plex-mono-latin-400-normal' },
  { family: 'Noto Sans JP', stem: 'noto-sans-jp-400' },
] as const;
type ExportFont = typeof faces[number]['family'];
const fontData = new Map<string, string>();
const measurementFonts = new Map<ExportFont, Promise<FontFace>>();
export async function blobDataUrl(blob: Blob, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const cleanup = () => signal?.removeEventListener('abort', aborted);
    const aborted = () => { cleanup(); reader.abort(); reject(signal?.reason ?? new DOMException('The export was cancelled.', 'AbortError')); };
    reader.onload = () => { cleanup(); resolve(String(reader.result)); };
    reader.onerror = () => { cleanup(); reject(new Error('The file could not be read.')); };
    signal?.addEventListener('abort', aborted, { once: true }); reader.readAsDataURL(blob);
  });
}
async function readBlob(url: string, signal?: AbortSignal): Promise<Blob> {
  signal?.throwIfAborted();
  const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);
  const response = await fetch(url, { credentials: 'same-origin', signal: requestSignal });
  if (!response.ok) throw new Error('An export font or image could not be loaded. Reconnect and try again.');
  return waitForSignal(response.blob(), requestSignal);
}
async function fontUrl(stem: string, format: 'woff' | 'ttf', signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted(); const key = `${stem}.${format}`, cached = fontData.get(key);
  if (cached) return cached;
  const blob = await readBlob(`/fonts/${key}`, signal), data = await blobDataUrl(new Blob([blob], { type: `font/${format}` }), signal);
  signal?.throwIfAborted(); fontData.set(key, data); return data;
}

function collectExportFonts(root: globalThis.Element, strict: boolean): Set<ExportFont> {
  const usedFonts = new Set<ExportFont>();
  // The model owns font spans and glyph positioning. Inspect complete line text
  // for coverage without rebuilding spans or discarding their explicit positions.
  for (const text of root.querySelectorAll('text')) {
    const family = text.getAttribute('font-family')!.includes('IBM Plex Mono') ? 'IBM Plex Mono' : 'Inter';
    let previousFont: ExportFont | undefined;
    for (const line of text.querySelectorAll(':scope > tspan')) {
      for (const run of resolveFontRuns(line.textContent ?? '', family, { strict, previousFont })) {
        usedFonts.add(run.family); previousFont = run.family;
      }
    }
  }
  return usedFonts;
}

/** jsPDF font registration alone does not load the browser fonts used by svg2pdf measurement. */
function measurementFont(family: ExportFont, data: string): Promise<FontFace> {
  let pending = measurementFonts.get(family);
  if (!pending) {
    pending = (async () => {
      const face = new FontFace(family, `url(${data})`, { style: 'normal', weight: '400' });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([face.load(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`The ${family} export font did not load.`)), 15_000); })]);
        document.fonts.add(face); return face;
      } finally { clearTimeout(timer); }
    })().catch(error => { measurementFonts.delete(family); throw error; });
    measurementFonts.set(family, pending);
  }
  return pending;
}

/** Resolve external bindings before selecting, so exports never need hidden peer shapes. */
export function captureExport(board: BoardDocument, selection?: readonly string[], padding = 24): ExportSnapshot {
  const all = board.readAll(), map = new Map(all.map(element => [element.id, element]));
  const ids = selection ? new Set(selection) : null;
  const elements = all.filter(element => !ids || ids.has(element.id)).map(element => {
    if (element.type !== 'connector' || !ids) return element;
    const binding = (value: typeof element.props.start) => 'elementId' in value && !ids.has(value.elementId) ? resolveBinding(value, map) : value;
    return { ...element, props: { ...element.props, start: binding(element.props.start), end: binding(element.props.end) } };
  });
  if (!elements.length) throw new Error('Add something to the board before exporting.');
  const raw = contentBounds(elements);
  return { elements, bounds: { x: raw.x - padding, y: raw.y - padding, w: Math.max(1, raw.w + 2 * padding), h: Math.max(1, raw.h + 2 * padding) } };
}

/** A cached, document-only projection excludes draft gestures and unselected overlaps. */
export class BoardExporter {
  private renderer?: ThreeRenderer;
  private busy = false;
  private destroyed = false;
  private active?: AbortController;
  constructor(private board: BoardDocument, private resolveAsset?: (id: string) => string | Promise<string>, private createProjection: typeof createRenderer = createRenderer) {}

  async create(options: ExportOptions): Promise<Blob> {
    if (this.destroyed) throw new Error('This board is closed.');
    if (this.busy) throw new Error('An export is already being prepared.');
    if (![1, 2, 3, 4].includes(options.scale)) throw new Error('Choose an export scale from 1× to 4×.');
    options.signal?.throwIfAborted();
    const controller = new AbortController(), aborted = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', aborted, { once: true });
    this.active = controller; this.busy = true;
    const warnings = new Set<string>(), warn = (id: string) => warnings.add(id);
    const request = { ...options, signal: controller.signal };
    try {
      const snapshot = captureExport(this.board, options.selection, options.padding);
      let blob: Blob;
      if (options.format === 'png') blob = await this.png(snapshot, request, warn);
      else {
        const svg = await this.svg(snapshot, request, warn);
        blob = options.format === 'svg' ? new Blob([svg], { type: 'image/svg+xml' }) : await this.pdf(svg, snapshot, request);
      }
      controller.signal.throwIfAborted(); options.onAssetWarnings?.([...warnings].sort()); return blob;
    } finally {
      options.signal?.removeEventListener('abort', aborted); this.active = undefined; this.busy = false;
      if (this.destroyed) { this.renderer?.dispose(); this.renderer = undefined; }
    }
  }

  private async png({ elements, bounds }: ExportSnapshot, options: ExportOptions, warn: (id: string) => void): Promise<Blob> {
    const w = Math.ceil(bounds.w * options.scale), h = Math.ceil(bounds.h * options.scale);
    if (w > 32767 || h > 32767 || w * h > 100_000_000) throw new Error('This PNG would be too large. Choose a smaller scale, a selection, or SVG.');
    this.renderer ??= this.createProjection({ canvas: document.createElement('canvas'), fontUrl: '/fonts/inter-latin-400-normal.woff', monoFontUrl: '/fonts/ibm-plex-mono-latin-400-normal.woff', fallbackFontUrl: '/fonts/noto-sans-jp-400.woff', resolveAsset: this.resolveAsset, background: '#ffffff', grid: false, pixelRatio: 1 });
    this.renderer.setElements(elements);
    this.renderer.resize(1, 1);
    this.renderer.setCamera({ x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2, zoom: 1 / Math.max(bounds.w, bounds.h) });
    const renderer = this.renderer;
    try { return await renderer.exportPng({ bounds, scale: options.scale, transparent: options.transparent, signal: options.signal, onAssetError: warn }); }
    catch (error) {
      // A lost projection cannot serve a later retry. Other failures retain its cache.
      if (error instanceof ExportContextLostError || options.signal?.aborted) { renderer.dispose(); this.renderer = undefined; }
      throw error;
    }
  }

  private async svg({ elements, bounds }: ExportSnapshot, options: ExportOptions, warn: (id: string) => void): Promise<string> {
    const textElements = elements.filter(element => element.type === 'text' || element.type === 'sticky');
    // Derive coverage from the model's canonical line/run layout without outlining
    // the board's strokes twice. Whitespace and following lines retain font state.
    const textSvg = documentToSvg(textElements, { bounds, padding: 0, background: null });
    const textRoot = new DOMParser().parseFromString(textSvg, 'image/svg+xml').documentElement;
    const usedFonts = collectExportFonts(textRoot, false);
    const fonts = await Promise.all(faces.filter(face => usedFonts.has(face.family)).map(async face => ({ family: face.family, dataUrl: await fontUrl(face.stem, 'woff', options.signal) })));
    const assets = new Map<string, { data: string; width: number; height: number } | null>();
    for (const element of elements) if (element.type === 'image' && !assets.has(element.props.assetId)) {
      const id = element.props.assetId;
      try {
        if (!this.resolveAsset) throw new Error('The image is unavailable for export.');
        const sourceSignal = AbortSignal.any([options.signal!, AbortSignal.timeout(15_000)]);
        const url = await waitForSignal(Promise.resolve().then(() => this.resolveAsset!(id)), sourceSignal);
        let blob = await readBlob(url, sourceSignal);
        if (blob.size > MAX_IMAGE_BYTES) throw new Error('The image exceeds the 20 MiB limit.');
        const header = readImageHeader(new Uint8Array(await waitForSignal(blob.arrayBuffer(), sourceSignal)));
        // Validate decoding before embedding bytes that could silently disappear in SVG/PDF.
        if (header.orientation) blob = await normalizeImageOrientation(blob, header, sourceSignal);
        else {
          const decoded = createImageBitmap(blob, { resizeWidth: 1, resizeHeight: 1 }).then(bitmap => { bitmap.close(); });
          await waitForSignal(decoded, sourceSignal);
        }
        assets.set(id, { data: await blobDataUrl(blob, sourceSignal), width: header.width, height: header.height });
      } catch (error) {
        options.signal?.throwIfAborted(); assets.set(id, null); warn(id);
      }
    }
    const projected = elements.map((element): Element => {
      if (element.type !== 'image') return element;
      const asset = assets.get(element.props.assetId);
      if (asset && asset.width === element.props.naturalW && asset.height === element.props.naturalH) return element;
      warn(element.props.assetId);
      return { ...element, type: 'rect', props: {}, style: { ...element.style, fill: IMAGE_ERROR_COLOR, stroke: IMAGE_ERROR_COLOR, strokeWidth: 0 } };
    });
    options.signal?.throwIfAborted();
    const svg = documentToSvg(projected, { bounds, padding: 0, background: options.transparent ? null : '#ffffff', title: options.title, fonts, assetUrl: id => assets.get(id)?.data });
    const root = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement;
    return new XMLSerializer().serializeToString(root);
  }

  private async pdf(svg: string, { bounds }: ExportSnapshot, options: ExportOptions): Promise<Blob> {
    const [{ jsPDF }] = await waitForSignal(Promise.all([import('jspdf'), import('svg2pdf.js')]), options.signal);
    const width = bounds.w * .75, height = bounds.h * .75;
    // PDF's standard page dimension limit is 14,400 points; preserve aspect ratio.
    const fit = Math.min(1, 14400 / Math.max(width, height));
    const pdf = new jsPDF({ unit: 'pt', format: [width * fit, height * fit], orientation: width > height ? 'landscape' : 'portrait', compress: true });
    const root = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement;
    // Retain the model's explicit spans: svg2pdf does not apply font GPOS features.
    const usedFonts = collectExportFonts(root, true);
    await Promise.all(faces.filter(face => usedFonts.has(face.family)).map(async face => {
      const data = await fontUrl(face.stem, 'ttf', options.signal);
      try { await waitForSignal(measurementFont(face.family, data), options.signal); }
      catch (error) { if (!options.signal?.aborted) fontData.delete(`${face.stem}.ttf`); throw error; }
      pdf.addFileToVFS(`${face.stem}.ttf`, data.slice(data.indexOf(',') + 1));
      pdf.addFont(`${face.stem}.ttf`, face.family, 'normal');
    }));
    pdf.setProperties({ title: options.title, creator: 'Whiteboard' });
    await waitForSignal(pdf.svg(root, { x: 0, y: 0, width: width * fit, height: height * fit }), options.signal);
    options.signal?.throwIfAborted();
    return pdf.output('blob');
  }

  destroy(): void { this.destroyed = true; this.active?.abort(new DOMException('This board is closed.', 'AbortError')); if (!this.busy) { this.renderer?.dispose(); this.renderer = undefined; } }
}

export function downloadExport(blob: Blob, title: string, extension: string): void {
  const url = URL.createObjectURL(blob), anchor = document.createElement('a');
  anchor.href = url; anchor.download = `${title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').trim().slice(0, 100) || 'whiteboard'}.${extension}`;
  anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
