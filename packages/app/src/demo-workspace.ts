import * as Y from 'yjs';
import { assertSafeImageDimensions, MAX_IMAGE_BYTES, readImageHeader, type BoardDocument } from '@whiteboard/model';
import type { AssetInfo, BoardInfo, ImportBudgetResponse, Session } from './api';
import { DemoStorage } from './demo-storage';

const prefix = 'whiteboard-demo:catalog:';
const active = new Map<string, { board: BoardDocument; storage: DemoStorage; urls: Map<string, string> }>();
const maxBoardBytes = 64 * 1024 * 1024;
interface DemoAsset { bytes: Uint8Array; mimeType: string; width: number; height: number }
const assets = (doc: Y.Doc) => doc.getMap<DemoAsset>('demo-assets');
const validateId = (id: string) => {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)) throw new Error('This board link is not valid.');
};
const saveInfo = (info: BoardInfo) => localStorage.setItem(prefix + info.id, JSON.stringify(info));
function localInfo(id: string): BoardInfo {
  validateId(id);
  const raw = localStorage.getItem(prefix + id);
  if (!raw) throw new Error('This board is not saved in this browser. Open its link in the browser where it was created. Sharing across devices is not available in this demo yet.');
  return JSON.parse(raw) as BoardInfo;
}
function opened(id: string) {
  const value = active.get(id);
  if (!value) throw new Error('Open the board before editing it.');
  return value;
}

export function attachDemoBoard(info: BoardInfo, board: BoardDocument, storage: DemoStorage, onError: (message: string) => void): () => void {
  const entry = { board, storage, urls: new Map<string, string>() };
  active.set(info.id, entry);
  const titleChanged = () => {
    const title = board.meta.get('title');
    try { saveInfo({ ...info, title: typeof title === 'string' ? title : info.title, updatedAt: Date.now() }); }
    catch { onError('The browser could not update your board list. Keep this board link and export your work before clearing any site data.'); }
  };
  board.meta.observe(titleChanged);
  titleChanged();
  return () => {
    board.meta.unobserve(titleChanged);
    if (active.get(info.id) === entry) active.delete(info.id);
    for (const url of entry.urls.values()) URL.revokeObjectURL(url);
  };
}

function storeAsset(id: string, asset: DemoAsset): AssetInfo {
  const { board } = opened(id);
  if (Y.encodeStateAsUpdate(board.doc).byteLength + asset.bytes.byteLength > maxBoardBytes) throw new Error('This demo board has reached its 64 MiB limit. Start another board for more images.');
  const assetId = crypto.randomUUID();
  assets(board.doc).set(assetId, asset);
  return { assetId, width: asset.width, height: asset.height, mimeType: asset.mimeType };
}

// Each tab gets an anonymous presence name. No accounts, cookies, or network requests.
let guest: Session | undefined;
export const demoApi = {
  config: async () => ({ googleSignIn: false, demo: true }),
  session: async (): Promise<Session> => {
    if (!guest) {
      const id = crypto.randomUUID();
      guest = { user: { id, username: `Guest ${id.slice(0, 4)}`, color: ['#5267ce', '#c46135', '#24836e', '#a64d83'][parseInt(id[0]!, 16) % 4] }, expiresAt: Number.MAX_SAFE_INTEGER, demo: true };
    }
    return guest;
  },
  login: async (): Promise<Session> => { throw new Error('The demo does not use sign-in.'); },
  logout: async () => {},
  boards: async (): Promise<BoardInfo[]> => {
    const result: BoardInfo[] = [];
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (key?.startsWith(prefix)) result.push(localInfo(key.slice(prefix.length)));
    }
    return result.sort((a, b) => b.updatedAt - a.updatedAt);
  },
  board: async (id: string) => localInfo(id),
  members: async () => [],
  createBoard: async (title: string): Promise<BoardInfo> => {
    const info: BoardInfo = { id: crypto.randomUUID(), title: title.trim().slice(0, 120) || 'Untitled board', role: 'owner', updatedAt: Date.now() };
    saveInfo(info); return info;
  },
  renameBoard: async (id: string, title: string): Promise<BoardInfo> => {
    const info = { ...localInfo(id), title: title.trim().slice(0, 120) || 'Untitled board', updatedAt: Date.now() };
    const { board, storage } = opened(id);
    board.meta.set('title', info.title);
    await storage.flush(); saveInfo(info); return info;
  },
  membership: async () => { throw new Error('Use another tab in this browser to try collaboration.'); },
  removeMember: async () => {},
  uploadAsset: async (id: string, file: Blob, signal?: AbortSignal): Promise<AssetInfo> => {
    signal?.throwIfAborted();
    if (file.size > MAX_IMAGE_BYTES) throw new Error('Images must be smaller than 20 MiB.');
    const bytes = new Uint8Array(await file.arrayBuffer());
    signal?.throwIfAborted();
    const header = readImageHeader(bytes); assertSafeImageDimensions(header.width, header.height);
    const result = storeAsset(id, { bytes, mimeType: header.mimeType, width: header.width, height: header.height });
    await opened(id).storage.flush(); return result;
  },
  importBudget: async (id: string): Promise<ImportBudgetResponse> => {
    const { board, storage } = opened(id); await storage.flush();
    return {
      limits: { maxUpdateBytes: 4 * 1024 * 1024, maxBoardBytes, maxInboundBytes: 16 * 1024 * 1024, maxInboundMessages: 1000, maxClockGrowth: 1_000_000 },
      storage: { snapshotBytes: Y.encodeStateAsUpdate(board.doc).byteLength, updateBytes: 0 },
      stateVector: btoa(Array.from(Y.encodeStateVector(board.doc), byte => String.fromCharCode(byte)).join('')),
    };
  },
  copyAsset: async (id: string, sourceBoardId: string, assetId: string): Promise<AssetInfo> => {
    localInfo(sourceBoardId);
    const source = active.get(sourceBoardId);
    const doc = source?.board.doc ?? new Y.Doc();
    const storage = source ? undefined : await DemoStorage.open(sourceBoardId, doc, () => {});
    try {
      const asset = assets(doc).get(assetId);
      if (!asset) throw new Error('The image is no longer saved in this browser.');
      const result = storeAsset(id, asset); await opened(id).storage.flush(); return result;
    } finally { if (storage) { await storage.destroy(); doc.destroy(); } }
  },
  assetUrl: (id: string, assetId: string): string => {
    const entry = opened(id), cached = entry.urls.get(assetId);
    if (cached) return cached;
    const asset = assets(entry.board.doc).get(assetId);
    if (!asset) throw new Error('This image is not saved in this browser.');
    const url = URL.createObjectURL(new Blob([Uint8Array.from(asset.bytes)], { type: asset.mimeType }));
    entry.urls.set(assetId, url); return url;
  },
};
