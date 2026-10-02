export interface User { id: string; username: string; name?: string; color?: string }
export interface Session { user: User; expiresAt: number }
export type BoardRole = 'owner' | 'editor' | 'viewer';
export interface BoardInfo { id: string; title: string; role: BoardRole; updatedAt: number }
export interface AssetInfo { assetId: string; mimeType?: string; url?: string }

export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); this.name = 'ApiError'; }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (typeof options.body === 'string' && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const response = await fetch(path, { ...options, credentials: 'same-origin', headers });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: unknown } | null;
    throw new ApiError(typeof body?.error === 'string' ? body.error : `Request failed (${response.status}). Please try again.`, response.status);
  }
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}

const boardPath = (id: string) => `/api/boards/${encodeURIComponent(id)}`;
export const api = {
  session: () => request<Session>('/api/session'),
  login: (username: string, password: string) => request<Session>('/api/session', { method: 'POST', body: JSON.stringify({ username, password }) }),
  logout: () => request<void>('/api/session/logout', { method: 'POST' }),
  boards: async () => (await request<{ boards: BoardInfo[] }>('/api/boards')).boards,
  board: async (id: string) => (await request<{ board: BoardInfo }>(boardPath(id))).board,
  createBoard: async (title: string) => (await request<{ board: BoardInfo }>('/api/boards', { method: 'POST', body: JSON.stringify({ title }) })).board,
  renameBoard: async (id: string, title: string) => (await request<{ board: BoardInfo }>(boardPath(id), { method: 'PATCH', body: JSON.stringify({ title }) })).board,
  membership: (id: string, username: string, role: 'editor' | 'viewer') => request<void>(`${boardPath(id)}/members`, { method: 'POST', body: JSON.stringify({ username, role }) }),
  removeMember: (id: string, username: string) => request<void>(`${boardPath(id)}/members/${encodeURIComponent(username)}`, { method: 'DELETE' }),
  uploadAsset: (id: string, file: Blob) => request<AssetInfo>(`${boardPath(id)}/assets`, { method: 'POST', headers: { 'Content-Type': file.type }, body: file }),
  copyAsset: (id: string, sourceBoardId: string, assetId: string) => request<AssetInfo>(`${boardPath(id)}/assets/copy`, { method: 'POST', body: JSON.stringify({ sourceBoardId, assetId }) }),
  assetUrl: (id: string, assetId: string) => `${boardPath(id)}/assets/${encodeURIComponent(assetId)}`,
};
