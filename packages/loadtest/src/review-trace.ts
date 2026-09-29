import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const path = process.argv[2];
if (!path) throw new Error('Usage: tsx src/review-trace.ts <completed-result.json>');
const file = resolve(path), result = JSON.parse(readFileSync(file, 'utf8'));
const events = readFileSync(file.replace(/\.json$/, '.ndjson'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
const samples = events.filter(event => event.type === 'sample');
assert.deepEqual(samples, result.samples, 'Summary must contain the exact raw samples');
assert(events.some(event => event.type === 'complete') && !events.some(event => event.type === 'failed'));
const warm = samples.filter(sample => sample.at >= result.startedAt + 300000);
assert(warm.length > 1);
function quantile(values: number[], q: number) {
  const sorted = [...values].sort((a, b) => a - b), index = (sorted.length - 1) * q;
  return sorted[Math.floor(index)]! + (sorted[Math.ceil(index)]! - sorted[Math.floor(index)]!) * (index % 1);
}
function distribution(values: number[]) { return { min: Math.min(...values), median: quantile(values, 0.5), p95: quantile(values, 0.95), max: Math.max(...values) }; }
const memory = (sample: any) => ({ elapsedSeconds: (sample.at - result.startedAt) / 1000, rssMiB: sample.rss / 1048576, heapMiB: sample.heapUsed / 1048576 });
const windows = Array.from({ length: Math.ceil((result.config.durationSeconds - 300) / 300) }, (_, index) => {
  const from = 300 + index * 300, to = Math.min(from + 300, result.config.durationSeconds);
  // Keep the final completion sample in the last window, including its small
  // post-workload acknowledgement/drain tail; report actual endpoints below.
  const selected = warm.filter(sample => sample.at >= result.startedAt + from * 1000 && (sample.at < result.startedAt + to * 1000 || to === result.config.durationSeconds));
  assert(selected.length > 0);
  const structs = selected.map(sample => (sample.documentStats ?? []).map((doc: any) => ({ writerArrays: doc.writerArrays, retained: doc.retainedStructs, deleted: doc.deletedStructs })));
  return { fromMinute: from / 60, toMinute: to / 60, sampleCount: selected.length, actualFirst: memory(selected[0]), actualLast: memory(selected.at(-1)),
    rssMiB: distribution(selected.map(sample => sample.rss / 1048576)), heapMiB: distribution(selected.map(sample => sample.heapUsed / 1048576)),
    structureStates: [...new Set(structs.map(value => JSON.stringify(value)))].map(value => JSON.parse(value)),
  };
});
const drops = warm.slice(1).flatMap((sample, index) => {
  const delta = (sample.heapUsed - warm[index]!.heapUsed) / 1048576;
  return delta <= -5 ? [{ elapsedSeconds: (sample.at - result.startedAt) / 1000, decreaseMiB: -delta, beforeHeapMiB: warm[index]!.heapUsed / 1048576, afterHeapMiB: sample.heapUsed / 1048576 }] : [];
});
const review = { result: file, samples: samples.length,
  firstPostWarmup: memory(warm[0]), lastPostWarmup: memory(warm.at(-1)),
  postWarmupEndpointDeltaMiB: { rss: (warm.at(-1)!.rss - warm[0]!.rss) / 1048576, heap: (warm.at(-1)!.heapUsed - warm[0]!.heapUsed) / 1048576 },
  maximumSampleIntervalMs: Math.max(...samples.map(sample => sample.elapsedMs)),
  actualMaximumTimestampGapMs: Math.max(...samples.slice(1).map((sample, index) => sample.at - samples[index]!.at)),
  windows, sampledHeapDropsAtLeast5MiB: drops,
  cleanChildExits: events.filter(event => event.type === 'process-exit').map(({ pid, code, signal }) => ({ pid, code, signal })),
  note: 'Descriptive evidence, not an automatic flat-memory verdict. Review window minima/medians, endpoints, plot and structure plateau together. Heap drops are sampled observations consistent with GC; no instrumented full-GC events are claimed. No forced GC, reset, trimming, or discarded trace samples. Quantiles use linear interpolation.' };
const output = file.replace(/\.json$/, '.trace-review.json'); writeFileSync(output, JSON.stringify(review, null, 2));
console.log(JSON.stringify({ output, ...review, sampledHeapDropsAtLeast5MiB: drops.length }, null, 2));
