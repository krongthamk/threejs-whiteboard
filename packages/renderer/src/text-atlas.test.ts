import { afterEach, expect, test, vi } from 'vitest';
import { syncTextAtlas, whenTextAtlasReady } from './text-atlas';

afterEach(() => vi.useRealTimers());
const deferredText = () => {
  let finish = () => {};
  return { text: { sync(callback?: () => void) { finish = () => callback?.(); } }, finish: () => finish() };
};

test('a cached text sync still waits for another mesh generating shared glyphs', async () => {
  const first = deferredText(), second = deferredText();
  syncTextAtlas(first.text, 1000, () => {}, () => {});
  syncTextAtlas(second.text, 1000, () => {}, () => {}); second.finish();
  let ready = false; const waiting = whenTextAtlasReady().then(() => { ready = true; });
  await Promise.resolve(); expect(ready).toBe(false);
  first.finish(); await waiting; expect(ready).toBe(true);
});

test('consumer disposal does not release in-flight atlas generation', async () => {
  const work = deferredText(), onReady = vi.fn();
  const cancel = syncTextAtlas(work.text, 1000, onReady, () => {}); cancel();
  let ready = false; const waiting = whenTextAtlasReady().then(() => { ready = true; });
  await Promise.resolve(); expect(ready).toBe(false);
  work.finish(); await waiting; expect(onReady).not.toHaveBeenCalled();
});

test('font deadline rejects waiting exports and releases shared tracking', async () => {
  vi.useFakeTimers(); const work = deferredText(), onError = vi.fn();
  syncTextAtlas(work.text, 25, () => {}, onError);
  const waiting = expect(whenTextAtlasReady()).rejects.toThrow('within 25 ms');
  await vi.advanceTimersByTimeAsync(25); await waiting;
  expect(onError).toHaveBeenCalledOnce(); await whenTextAtlasReady();
  work.finish(); expect(onError).toHaveBeenCalledOnce();
});
