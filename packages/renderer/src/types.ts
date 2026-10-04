import type { Element, ElementOf, ElementStyle } from '@whiteboard/model';
import type { SelectionState } from './selection';
/** Document coordinates are CSS pixels at 100%, with positive y pointing down. */
export interface CameraState { x: number; y: number; zoom: number }
export interface Bounds { x: number; y: number; w: number; h: number }
export interface RemotePresence {
  clientId: string | number; name: string; color: string; cursor: { x: number; y: number } | null;
  selection: readonly string[]; editingTextId?: string | null; viewport?: Bounds | null;
}
export type RendererStyle = ElementStyle;
export type RenderElement = Element;
export interface RendererStats {
  calls: number; triangles: number; geometries: number; textures: number;
  elements: number; shapeInstances: number; strokeChunks: number; strokeChunkRebuilds: number; connectorRebuilds: number;
  textInstances: number; visibleTexts: number; pendingTexts: number; textErrors: number; textDisposals: number;
  presencePeers: number; presenceLabels: number; pendingPresenceLabels: number; presenceErrors: number;
  imageInstances: number; visibleImages: number; pendingImages: number; imageErrors: number;
}
export interface PngOptions { bounds: Bounds; scale?: number; transparent?: boolean; signal?: AbortSignal; onAssetError?: (assetId: string) => void }
export interface Renderer {
  setElements(elements: readonly RenderElement[]): void;
  applyDiff(upserts: readonly RenderElement[], removals?: readonly string[]): void;
  setCamera(camera: CameraState): void;
  getCamera(): CameraState;
  setSelection(selection: SelectionState): void;
  setLiveStroke(element: ElementOf<'stroke'> | null): void;
  setPresence(presences: readonly RemotePresence[]): void;
  getImageError(id: string): Error | undefined;
  getMaxImageDimension(): number;
  setPixelRatio(ratio: number): void;
  resize(width: number, height: number): void;
  /** Explicit draw by default; false skips a frame with no projection changes. */
  render(force?: boolean): void;
  whenReady(): Promise<void>;
  exportPng(options: PngOptions): Promise<Blob>;
  stats(): RendererStats;
  dispose(): void;
}
export interface RendererOptions {
  canvas: HTMLCanvasElement; fontUrl: string; monoFontUrl?: string;
  /** Defaults to noto-sans-jp-400.woff beside fontUrl. Configured before first troika layout. */
  fallbackFontUrl?: string;
  /** Bound a failed font/layout request so export and readiness never wait indefinitely. */
  fontLoadTimeoutMs?: number;
  /** Resolve immutable asset IDs to readable URLs; image bytes remain outside the document. */
  resolveAsset?: (assetId: string) => string | Promise<string>;
  imageLoadTimeoutMs?: number;
  maxDisplayImageSize?: number;
  pixelRatio?: number; background?: string; grid?: boolean;
}
