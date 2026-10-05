import { generateKeyBetween } from 'fractional-indexing';
import { BoardDocument, createElement, assertSafeImageDimensions, readImageHeader, type Element as BoardElement, type Point } from '@whiteboard/model';
import { api } from './api';
import { normalizeImageOrientation } from './image-orientation';
import type { SessionStore } from './session';
import { encodeClipboard, parseClipboard, preparePastedElements, type ClipboardEnvelope } from './clipboard-model';
import { ExcalidrawImporter, isExcalidrawText, type ImportReport } from './excalidraw-import';
import type { ImportTransport } from './import-transport';
import { MAX_EXCALIDRAW_BYTES } from '@whiteboard/model';

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export interface BoardAssetsOptions {
  canvas: HTMLCanvasElement;
  boardId: string;
  board: BoardDocument;
  session: SessionStore;
  isReadOnly(): boolean;
  maxImageDimension(): number;
  onError(message: string): void;
  onBusy?(busy: boolean): void;
  importTransport?: ImportTransport;
  onImportReport?(report: ImportReport): void;
}
interface DecodedFile { file: File; blob: Blob; width: number; height: number }

/** Browser I/O for images and clipboard; Excalidraw additions use exact, acknowledged import batches. */
export class BoardAssets {
  private stopped = false;
  private activeJobs = 0;
  private readonly excalidraw: ExcalidrawImporter;

  constructor(private readonly options: BoardAssetsOptions) {
    this.excalidraw = new ExcalidrawImporter({ ...options, transport: options.importTransport, onReport: options.onImportReport });
    options.canvas.addEventListener('dragover', this.dragOver);
    options.canvas.addEventListener('drop', this.drop);
    window.addEventListener('copy', this.copy);
    window.addEventListener('cut', this.cut);
    window.addEventListener('paste', this.paste);
  }

  private report(error: unknown): void {
    if (!this.stopped) this.options.onError(error instanceof Error ? error.message : 'The image or clipboard content could not be imported.');
  }
  private writable(): boolean {
    if (this.stopped) return false;
    if (this.options.isReadOnly()) throw new Error('This board is read-only.');
    return true;
  }
  private async run(operation: () => Promise<void>): Promise<void> {
    if (this.stopped) return;
    if (++this.activeJobs === 1) this.options.onBusy?.(true);
    try { await operation(); } catch (error) { this.report(error); }
    finally { if (--this.activeJobs === 0 && !this.stopped) this.options.onBusy?.(false); }
  }
  private ignore(event: Event): boolean {
    if (this.stopped || event.defaultPrevented || document.querySelector('[role="dialog"],dialog[open]')) return true;
    const target = event.target instanceof HTMLElement ? event.target : document.activeElement;
    return !!target?.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="dialog"],dialog');
  }
  private world(point: Point): Point {
    const rect = this.options.canvas.getBoundingClientRect(), camera = this.options.session.getState().camera;
    return { x: camera.x + (point.x - rect.left - rect.width / 2) / camera.zoom, y: camera.y + (point.y - rect.top - rect.height / 2) / camera.zoom };
  }
  private center(): Point { const { x, y } = this.options.session.getState().camera; return { x, y }; }
  private dimensions(width: number, height: number, name = 'Image'): void {
    const limit = this.options.maxImageDimension();
    if (!Number.isFinite(limit) || limit < 1) throw new Error('The renderer image limit is unavailable. Try again after the canvas is ready.');
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) throw new Error(`${name} has invalid image dimensions.`);
    assertSafeImageDimensions(width, height);
    if (width > limit || height > limit) throw new Error(`${name} is ${width} × ${height} pixels. This device supports images up to ${limit} pixels per side.`);
  }
  private async decode(file: File): Promise<DecodedFile> {
    let header;
    try { header = readImageHeader(new Uint8Array(await file.arrayBuffer())); }
    catch { throw new Error(`${file.name || 'This file'} is not a PNG, JPEG, or WebP image with a valid header.`); }
    this.dimensions(header.width, header.height, file.name || 'Image');
    assertSafeImageDimensions(header.width, header.height);
    // Keep ordinary immutable source bytes; bake nontrivial EXIF transforms into pixels.
    const blob = file.slice(0, file.size, header.mimeType);
    if (header.orientation) return { file, blob: await normalizeImageOrientation(blob, header), width: header.width, height: header.height };
    let width: number, height: number;
    try {
      if (typeof createImageBitmap === 'function') {
        const bitmap = await createImageBitmap(blob);
        try { width = bitmap.width; height = bitmap.height; } finally { bitmap.close(); }
      } else {
        const url = URL.createObjectURL(blob), image = new Image();
        try { image.src = url; await image.decode(); width = image.naturalWidth; height = image.naturalHeight; }
        finally { image.src = ''; URL.revokeObjectURL(url); }
      }
    } catch { throw new Error(`${file.name || 'This image'} could not be decoded.`); }
    if (width !== header.width || height !== header.height) throw new Error(`${file.name || 'This image'} has inconsistent encoded dimensions.`);
    return { file, blob, width: header.width, height: header.height };
  }

  /** Errors surface through onError. An interrupted split Excalidraw import may retain completed batches. */
  async importFiles(files: readonly File[], point = this.center()): Promise<void> {
    if (files.length === 0) return;
    const documents = files.filter(file => /\.(?:excalidraw|json)$/i.test(file.name) || file.type === 'application/json');
    if (documents.length) {
      await this.run(async () => {
        if (!this.writable()) return;
        for (const file of documents) {
          if (file.size > MAX_EXCALIDRAW_BYTES) throw new Error(`${file.name} exceeds the 50 MiB Excalidraw limit.`);
          const text = await file.text(); if (!this.writable()) return;
          await this.excalidraw.importText(text, file.size);
        }
      });
      const images = files.filter(file => !documents.includes(file));
      if (images.length) await this.importFiles(images, point);
      return;
    }
    await this.run(async () => {
      if (!this.writable()) return;
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new Error('The image insertion point is invalid.');
      for (const file of files) {
        if (!file.size) throw new Error(`${file.name || 'This file'} is empty.`);
        if (file.size > MAX_IMAGE_BYTES) throw new Error(`${file.name || 'This image'} exceeds the 20 MiB upload limit.`);
      }
      // Decode sequentially and immediately release decoded pixels, before starting any upload.
      const decoded: DecodedFile[] = [];
      for (const file of files) { decoded.push(await this.decode(file)); if (!this.writable()) return; }
      const uploaded: { image: DecodedFile; assetId: string }[] = [];
      for (const image of decoded) {
        if (!this.writable()) return;
        const asset = await api.uploadAsset(this.options.boardId, image.blob);
        if (!asset.assetId) throw new Error('The server did not return an image asset ID.');
        this.dimensions(asset.width, asset.height, image.file.name);
        assertSafeImageDimensions(asset.width, asset.height);
        if (asset.width !== image.width || asset.height !== image.height) throw new Error('The server returned inconsistent image dimensions.');
        uploaded.push({ image: { ...image, width: asset.width, height: asset.height }, assetId: asset.assetId });
      }
      if (!this.writable()) return;
      const { camera } = this.options.session.getState(), bounds = this.options.canvas.getBoundingClientRect();
      const maxWidth = Math.max(1, Math.min(600, bounds.width * .6 / camera.zoom));
      const maxHeight = Math.max(1, Math.min(450, bounds.height * .6 / camera.zoom));
      let index = this.options.board.highestIndex();
      const elements = uploaded.map(({ image, assetId }, offset) => {
        this.dimensions(image.width, image.height, image.file.name);
        const scale = Math.min(1, maxWidth / image.width, maxHeight / image.height);
        const w = image.width * scale, h = image.height * scale, shift = (offset - (uploaded.length - 1) / 2) * 24 / camera.zoom;
        index = generateKeyBetween(index, null);
        return createElement('image', { id: crypto.randomUUID(), x: point.x - w / 2 + shift, y: point.y - h / 2 + shift, w, h, index,
          style: { strokeWidth: 0 }, props: { assetId, naturalW: image.width, naturalH: image.height } });
      });
      this.insert(elements);
    });
  }
  private insert(elements: readonly BoardElement[]): void {
    if (!this.writable()) return;
    // Preparation completed before this non-rollback Yjs transaction; no asynchronous work occurs inside it.
    this.options.board.transact(() => { for (const element of elements) this.options.board.add(element); });
    this.options.session.setState({ selectedIds: elements.map(element => element.id), tool: 'select' });
  }
  private selection(): { ids: string[]; text: string } | null {
    const ids = this.options.session.getState().selectedIds.filter(id => !!this.options.board.read(id));
    return ids.length ? { ids, text: encodeClipboard(this.options.boardId, ids, this.options.board.readAll()) } : null;
  }
  private finishCut(ids: readonly string[]): void {
    if (!this.writable()) return;
    this.options.board.delete(ids); this.options.session.setState({ selectedIds: [] });
  }
  async copySelection(cut = false): Promise<void> {
    await this.run(async () => {
      if (cut && !this.writable()) return;
      const selection = this.selection(); if (!selection) return;
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard access is unavailable. Use the keyboard Copy command.');
      await navigator.clipboard.writeText(selection.text);
      if (cut && !this.stopped) this.finishCut(selection.ids);
    });
  }
  private nativeCopy(event: ClipboardEvent, cut: boolean): void {
    if (this.ignore(event) || cut && this.options.isReadOnly()) return;
    try {
      const selection = this.selection(); if (!selection || !event.clipboardData) return;
      event.clipboardData.setData('text/plain', selection.text);
      if (event.clipboardData.getData('text/plain') !== selection.text) throw new Error('The selection could not be written to the clipboard.');
      event.preventDefault();
      if (cut) this.finishCut(selection.ids);
    } catch (error) { this.report(error); }
  }
  private copy = (event: ClipboardEvent): void => this.nativeCopy(event, false);
  private cut = (event: ClipboardEvent): void => this.nativeCopy(event, true);
  private async importClipboard(envelope: ClipboardEnvelope): Promise<void> {
    const center = this.center();
    await this.run(async () => {
      if (!this.writable()) return;
      const assets = new Set<string>();
      for (const element of envelope.elements) if (element.type === 'image') {
        this.dimensions(element.props.naturalW, element.props.naturalH); assets.add(element.props.assetId);
      }
      const imageAssetIds = new Map<string, string>();
      for (const assetId of assets) {
        if (!this.writable()) return;
        let width: number, height: number;
        if (envelope.sourceBoardId !== this.options.boardId) {
          const copied = await api.copyAsset(this.options.boardId, envelope.sourceBoardId, assetId);
          if (!copied.assetId) throw new Error('The server did not return a copied image asset ID.');
          ({ width, height } = copied); imageAssetIds.set(assetId, copied.assetId);
        } else {
          const response = await fetch(api.assetUrl(this.options.boardId, assetId), { credentials: 'same-origin' });
          if (!response.ok) throw new Error('The clipboard image could not be read.');
          const blob = await response.blob();
          if (blob.size > MAX_IMAGE_BYTES) throw new Error('The clipboard image exceeds the 20 MiB upload limit.');
          ({ width, height } = readImageHeader(new Uint8Array(await blob.arrayBuffer())));
        }
        this.dimensions(width, height);
        for (const element of envelope.elements) if (element.type === 'image' && element.props.assetId === assetId
          && (element.props.naturalW !== width || element.props.naturalH !== height)) throw new Error('The clipboard image dimensions do not match its source.');
      }
      if (!this.writable()) return;
      const prepared = preparePastedElements(envelope, { targetBoardId: this.options.boardId, center,
        highestIndex: this.options.board.highestIndex(),
        newIds: envelope.elements.map(() => crypto.randomUUID()), imageAssetIds });
      this.insert(prepared);
    });
  }
  private paste = (event: ClipboardEvent): void => {
    if (this.ignore(event) || !event.clipboardData) return;
    try {
      const text = event.clipboardData.getData('text/plain');
      // Recognize Excalidraw before the whiteboard clipboard's smaller 8 MiB cap.
      if (text && isExcalidrawText(text)) { event.preventDefault(); void this.run(async () => { if (this.writable()) await this.excalidraw.importText(text); }); return; }
      const envelope = text ? parseClipboard(text) : null;
      if (envelope) { event.preventDefault(); void this.importClipboard(envelope); return; }
      const files = Array.from(event.clipboardData.files);
      if (files.length) { event.preventDefault(); void this.importFiles(files); }
    } catch (error) { event.preventDefault(); this.report(error); }
  };
  private dragOver = (event: DragEvent): void => {
    if (this.stopped || !event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault(); event.dataTransfer.dropEffect = this.options.isReadOnly() ? 'none' : 'copy';
  };
  private drop = (event: DragEvent): void => {
    if (this.ignore(event) || !event.dataTransfer?.files.length) return;
    event.preventDefault(); void this.importFiles(Array.from(event.dataTransfer.files), this.world({ x: event.clientX, y: event.clientY }));
  };
  destroy(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.excalidraw.destroy();
    this.options.canvas.removeEventListener('dragover', this.dragOver); this.options.canvas.removeEventListener('drop', this.drop);
    window.removeEventListener('copy', this.copy); window.removeEventListener('cut', this.cut); window.removeEventListener('paste', this.paste);
  }
}
