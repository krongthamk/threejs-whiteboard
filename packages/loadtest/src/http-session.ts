/** Explicit HTTP harness credentials come from Set-Cookie, never the JSON body. */
export async function readHttpSession(response: Response): Promise<{ user: { id: string }; expiresAt: number; token: string }> {
  if (!response.ok) throw new Error(`Session login failed (${response.status}).`);
  const body: unknown = await response.json();
  if (!body || typeof body !== 'object' || !('user' in body) || !body.user || typeof body.user !== 'object'
    || !('id' in body.user) || typeof body.user.id !== 'string' || !body.user.id
    || !('expiresAt' in body) || typeof body.expiresAt !== 'number' || !Number.isFinite(body.expiresAt)) {
    throw new Error('Session login returned invalid account metadata.');
  }
  const cookie = response.headers.getSetCookie().find(value => value.startsWith('board_session='));
  let token: string;
  try { token = decodeURIComponent(cookie?.split(';', 1)[0]?.slice('board_session='.length) ?? ''); }
  catch { throw new Error('Session login returned an invalid session cookie.'); }
  if (!token) throw new Error('Session login did not set a session cookie.');
  return { user: { id: body.user.id }, expiresAt: body.expiresAt, token };
}
