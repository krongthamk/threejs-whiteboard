import type { Element, ElementStyle } from '@whiteboard/model';
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
  /** Maximum detached handles retained after their last viewport visit (default 256). */
  offscreenTextCacheSize?: number;
  offscreenImageCacheSize?: number;
  pixelRatio?: number; background?: string; grid?: boolean;
}
