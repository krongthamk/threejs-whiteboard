import { contentBounds, documentToSvg, resolveBinding, resolveFontRuns, type BoardDocument, type Box, type Element } from '@whiteboard/model';
import { createRenderer, type ThreeRenderer } from '@whiteboard/renderer';

export interface ExportOptions { format: 'png' | 'svg' | 'pdf'; selection?: readonly string[]; scale: number; transparent: boolean; title: string; padding?: number }
export interface ExportSnapshot { elements: Element[]; bounds: Box }
const faces = [
  { family: 'Inter', stem: 'inter-latin-400-normal' },
  { family: 'IBM Plex Mono', stem: 'ibm-plex-mono-latin-400-normal' },
  { family: 'Noto Sans JP', stem: 'noto-sans-jp-400' },
] as const;
type ExportFont = typeof faces[number]['family'];
const fontData = new Map<string, Promise<string>>();
const measurementFonts = new Map<ExportFont, Promise<FontFace>>();
export async function blobDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('The file could not be read.')); reader.readAsDataURL(blob); });
}
async function readUrl(url: string, mime?: string): Promise<string> {
  const response = await fetch(url, { credentials: 'same-origin', signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error('An export font or image could not be loaded. Reconnect and try again.');
  const blob = await response.blob(); return blobDataUrl(mime ? new Blob([blob], { type: mime }) : blob);
}
function fontUrl(stem: string, format: 'woff' | 'ttf'): Promise<string> {
  const key = `${stem}.${format}`;
  if (!fontData.has(key)) fontData.set(key, readUrl(`/fonts/${key}`, `font/${format}`).catch(error => { fontData.delete(key); throw error; }));
  return fontData.get(key)!;
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
  constructor(private board: BoardDocument, private resolveAsset?: (id: string) => string | Promise<string>) {}

  async create(options: ExportOptions): Promise<Blob> {
    if (this.destroyed) throw new Error('This board is closed.');
    if (this.busy) throw new Error('An export is already being prepared.');
    if (![1, 2, 3, 4].includes(options.scale)) throw new Error('Choose an export scale from 1× to 4×.');
    this.busy = true;
    try {
      const snapshot = captureExport(this.board, options.selection, options.padding);
      if (options.format === 'png') return await this.png(snapshot, options);
      const svg = await this.svg(snapshot, options);
      if (options.format === 'svg') return new Blob([svg], { type: 'image/svg+xml' });
      return await this.pdf(svg, snapshot, options);
    } finally { this.busy = false; if (this.destroyed) this.renderer?.dispose(); }
  }

  private async png({ elements, bounds }: ExportSnapshot, options: ExportOptions): Promise<Blob> {
    const w = Math.ceil(bounds.w * options.scale), h = Math.ceil(bounds.h * options.scale);
    if (w > 32767 || h > 32767 || w * h > 100_000_000) throw new Error('This PNG would be too large. Choose a smaller scale, a selection, or SVG.');
    this.renderer ??= createRenderer({ canvas: document.createElement('canvas'), fontUrl: '/fonts/inter-latin-400-normal.woff', monoFontUrl: '/fonts/ibm-plex-mono-latin-400-normal.woff', fallbackFontUrl: '/fonts/noto-sans-jp-400.woff', resolveAsset: this.resolveAsset, background: '#ffffff', grid: false, pixelRatio: 1 });
    this.renderer.setElements(elements);
    this.renderer.resize(1, 1);
    this.renderer.setCamera({ x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2, zoom: 1 / Math.max(bounds.w, bounds.h) });
    return this.renderer.exportPng({ bounds, scale: options.scale, transparent: options.transparent });
  }

  private async svg({ elements, bounds }: ExportSnapshot, options: ExportOptions): Promise<string> {
    const fonts = elements.some(element => element.type === 'text' || element.type === 'sticky')
      ? await Promise.all(faces.map(async face => ({ family: face.family, dataUrl: await fontUrl(face.stem, 'woff') }))) : [];
    const assets = new Map<string, string>();
    for (const element of elements) if (element.type === 'image' && !assets.has(element.props.assetId)) {
      if (!this.resolveAsset) throw new Error('The image is unavailable for export.');
      const url = await this.resolveAsset(element.props.assetId);
      assets.set(element.props.assetId, await readUrl(url));
    }
    const svg = documentToSvg(elements, { bounds, padding: 0, background: options.transparent ? null : '#ffffff', title: options.title, fonts, assetUrl: id => assets.get(id) });
    const root = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement;
    collectExportFonts(root, false);
    return new XMLSerializer().serializeToString(root);
  }

  private async pdf(svg: string, { bounds }: ExportSnapshot, options: ExportOptions): Promise<Blob> {
    const [{ jsPDF }] = await Promise.all([import('jspdf'), import('svg2pdf.js')]);
    const width = bounds.w * .75, height = bounds.h * .75;
    // PDF's standard page dimension limit is 14,400 points; preserve aspect ratio.
    const fit = Math.min(1, 14400 / Math.max(width, height));
    const pdf = new jsPDF({ unit: 'pt', format: [width * fit, height * fit], orientation: width > height ? 'landscape' : 'portrait', compress: true });
    const root = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement;
    // Retain the model's explicit spans: svg2pdf does not apply font GPOS features.
    const usedFonts = collectExportFonts(root, true);
    await Promise.all(faces.filter(face => usedFonts.has(face.family)).map(async face => {
      const data = await fontUrl(face.stem, 'ttf');
      try { await measurementFont(face.family, data); }
      catch (error) { fontData.delete(`${face.stem}.ttf`); throw error; }
      pdf.addFileToVFS(`${face.stem}.ttf`, data.slice(data.indexOf(',') + 1));
      pdf.addFont(`${face.stem}.ttf`, face.family, 'normal');
    }));
    pdf.setProperties({ title: options.title, creator: 'Whiteboard' });
    await pdf.svg(root, { x: 0, y: 0, width: width * fit, height: height * fit });
    return pdf.output('blob');
  }

  destroy(): void { this.destroyed = true; if (!this.busy) this.renderer?.dispose(); }
}

export function downloadExport(blob: Blob, title: string, extension: string): void {
  const url = URL.createObjectURL(blob), anchor = document.createElement('a');
  anchor.href = url; anchor.download = `${title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').trim().slice(0, 100) || 'whiteboard'}.${extension}`;
  anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
