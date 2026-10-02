import { expect, test } from 'vitest';
import { readHttpSession } from './http-session';

const metadata = { user: { id: 'account-id' }, expiresAt: 123456789 };
test('token-free login metadata and Set-Cookie authenticate the HTTP harness', async () => {
  const response = new Response(JSON.stringify(metadata), { headers: { 'Set-Cookie': 'board_session=signed%2Bcookie; HttpOnly; Path=/; SameSite=Lax' } });
  expect(await readHttpSession(response)).toEqual({ ...metadata, token: 'signed+cookie' });
});
test('a JSON bearer field cannot replace the required session cookie', async () => {
  const response = new Response(JSON.stringify({ ...metadata, token: 'body-token' }));
  await expect(readHttpSession(response)).rejects.toThrow('did not set a session cookie');
});
test('login failures and malformed cookies produce errors without exposing credentials', async () => {
  await expect(readHttpSession(new Response('{}', { status: 401 }))).rejects.toThrow('Session login failed (401)');
  const response = new Response(JSON.stringify(metadata), { headers: { 'Set-Cookie': 'board_session=%bad-credential; HttpOnly' } });
  await expect(readHttpSession(response)).rejects.toThrow('invalid session cookie');
});
