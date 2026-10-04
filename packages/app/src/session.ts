import { createStore, type StoreApi } from 'zustand/vanilla';
import { DEFAULT_STYLE, type ElementStyle } from '@whiteboard/model';
import type { CameraState } from '@whiteboard/renderer';

export type Tool = 'select' | 'rect' | 'ellipse' | 'sticky' | 'text' | 'connector' | 'draw' | 'eraser' | 'pan';
export interface SessionState {
  tool: Tool;
  camera: CameraState;
  selectedIds: string[];
  style: ElementStyle;
  snap: boolean;
  connectorKind: 'straight' | 'elbow';
}
export type SessionStore = StoreApi<SessionState> & { dispose(): void };

function boundedCamera(camera: CameraState, previous: CameraState): CameraState {
  const bounded = (value: number, min: number, max: number, fallback: number) => Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
  const x = bounded(camera.x, -1e6, 1e6, previous.x), y = bounded(camera.y, -1e6, 1e6, previous.y);
  const zoom = bounded(camera.zoom, .02, 64, previous.zoom);
  return x === camera.x && y === camera.y && zoom === camera.zoom ? camera : { x, y, zoom };
}

/** Only personal view settings go to localStorage. Document and awareness do not. */
export function createSession(boardId: string): SessionStore {
  const key = `whiteboard:view:${boardId}`;
  let camera: CameraState = { x: 0, y: 0, zoom: 1 };
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? 'null') as CameraState | null;
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y) && Number.isFinite(saved.zoom)) {
      camera = boundedCamera(saved, camera);
    }
  } catch { /* A private or full storage area should not prevent opening a board. */ }
  const store = createStore<SessionState>(() => ({
    tool: 'select', camera, selectedIds: [], snap: false, connectorKind: 'straight',
    style: { ...DEFAULT_STYLE, stroke: '#334155', fill: '#ffffff', color: '#1d2b40' },
  }));
  // Normalize before notifying listeners, for every navigation path: wheel,
  // pinch, minimap, fit, and persisted views all use this session boundary.
  const setState = store.setState;
  store.setState = (update, replace) => {
    const previous = store.getState();
    const next = typeof update === 'function' ? update(previous) : update;
    const camera = next.camera && boundedCamera(next.camera, previous.camera);
    const normalized = camera && camera !== next.camera ? { ...next, camera } : next;
    if (replace) setState(normalized as SessionState, true);
    else setState(normalized);
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const persist = () => {
    try { localStorage.setItem(key, JSON.stringify(store.getState().camera)); } catch { /* Best effort session setting. */ }
  };
  const unsubscribe = store.subscribe((state, previous) => {
    if (state.camera === previous.camera) return;
    clearTimeout(timer); timer = setTimeout(persist, 120);
  });
  return Object.assign(store, { dispose() { clearTimeout(timer); persist(); unsubscribe(); } });
}
