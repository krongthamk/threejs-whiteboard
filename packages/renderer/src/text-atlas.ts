import type { Text } from 'troika-three-text';

// Troika publishes shared glyph-cache entries before generating their SDF texels.
// A second renderer's sync can finish while the first still owns that generation.
const pending = new Set<Promise<void>>();

/** Cancel only the consumer: Troika's shared atlas work continues until completion. */
export function syncTextAtlas(text: Pick<Text, 'sync'>, timeoutMs: number, onReady: () => void, onError: (error: Error) => void): () => void {
  let active = true, finished = false;
  let resolveWork!: () => void, rejectWork!: (error: Error) => void;
  const work = new Promise<void>((resolve, reject) => { resolveWork = resolve; rejectWork = reject; });
  pending.add(work);
  void work.catch(() => {}); // Ordinary rendering reports failures through its consumer.
  const finish = (error?: Error) => {
    if (finished) return;
    finished = true; clearTimeout(timer); pending.delete(work);
    if (error) rejectWork(error); else resolveWork();
    if (active) { if (error) onError(error); else onReady(); }
  };
  const timer = setTimeout(() => finish(new Error(`Text font/layout did not finish within ${timeoutMs} ms. Check local font files and character coverage.`)), timeoutMs);
  try { text.sync(() => finish()); }
  catch (error) { finish(error instanceof Error ? error : new Error('Text font/layout could not be generated.')); }
  return () => { active = false; };
}

/** Wait for current generation even if this renderer only reused cached glyphs. */
export async function whenTextAtlasReady(): Promise<void> { await Promise.all([...pending]); }
