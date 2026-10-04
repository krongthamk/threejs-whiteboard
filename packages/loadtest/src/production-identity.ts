/** Resolve the identity the production server will accept for this session. */
export async function productionIdentity(serverUrl: string, token: string): Promise<{ userId: string; name: string }> {
  const response = await fetch(new URL('/api/session', serverUrl), { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`Production session could not be confirmed (${response.status})`);
  const session: unknown = await response.json();
  const user = session && typeof session === 'object' && 'user' in session ? session.user : undefined;
  if (!user || typeof user !== 'object' || !('id' in user) || typeof user.id !== 'string' || !user.id
    || !('username' in user) || typeof user.username !== 'string' || !user.username) throw new Error('Production session identity is invalid');
  const name = 'name' in user ? user.name : user.username;
  if (typeof name !== 'string' || !name) throw new Error('Production session identity is invalid');
  return { userId: user.id, name };
}
