import { test, expect } from '@playwright/test';
import { shardFor } from '../../packages/server/src/router';
import type { EditorRuntime } from '../../packages/app/src/runtime';

declare global { interface Window { whiteboard: EditorRuntime } }

test('the actual app connects, persists and reloads boards on both routed owners', async ({ page }) => {
  const sockets: string[] = []; page.on('websocket', socket => sockets.push(socket.url()));
  await page.goto('/');
  await page.getByLabel('Username', { exact: true }).fill('alice');
  await page.getByLabel('Password', { exact: true }).fill('browser-test-only-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'New board', exact: true })).toBeVisible();
  const nodes = [{ id: 'a', url: 'http://a' }, { id: 'b', url: 'http://b' }];
  const boards = new Map<string, { id: string; title: string }>();
  for (let attempt = 0; boards.size < 2 && attempt < 40; attempt++) {
    const board = await page.evaluate(async () => {
      const response = await fetch('/api/boards', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Routed board' }) });
      if (!response.ok) throw new Error(await response.text());
      return (await response.json()).board as { id: string; title: string };
    });
    boards.set(shardFor(board.id, nodes).id, board);
  }
  expect(boards.size).toBe(2);
  for (const [owner, board] of boards) {
    const other = boards.get(owner === 'a' ? 'b' : 'a')!;
    await page.goto(`/board/${board.id}`);
    await expect(page.getByRole('status').filter({ hasText: /^Connected/ })).toBeVisible();
    await page.getByRole('button', { name: 'Rectangle', exact: true }).click();
    await page.mouse.move(500, 350); await page.mouse.down(); await page.mouse.move(640, 450, { steps: 4 }); await page.mouse.up();
    await expect.poll(() => page.evaluate(() => window.whiteboard.board.readAll().length)).toBe(1);
    const metrics = await page.evaluate(async ({ current, other }) => {
      const read = async (id: string) => (await (await fetch(`/api/metrics?boardId=${id}`)).json()).boards;
      return { owner: await read(current), other: await read(other) };
    }, { current: board.id, other: other.id });
    expect(metrics.owner.find((item: { boardId: string }) => item.boardId === board.id).connections).toBe(1);
    expect(metrics.other.find((item: { boardId: string }) => item.boardId === board.id).connections).toBe(0);
    expect(sockets.some(url => new URL(url).searchParams.get('boardId') === board.id)).toBe(true);
    await page.reload(); await expect(page.getByRole('status').filter({ hasText: /^Connected/ })).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.whiteboard.board.readAll().length)).toBe(1);
  }
});
