import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

const path = process.argv[2];
if (!path) throw new Error('Usage: pnpm --filter @whiteboard/loadtest verify <result.json>');
const file = resolve(path);
const result = JSON.parse(readFileSync(file, 'utf8'));
const events = readFileSync(file.replace(/\.json$/, '.ndjson'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
const samples = events.filter(event => event.type === 'sample');
const bytes = readFileSync(file.replace(/\.json$/, '.latencies.f64le'));
const latencies = Array.from({ length: bytes.length / 8 }, (_, index) => bytes.readDoubleLE(index * 8));
const assertions: Record<string, boolean> = {};
const p95 = latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))];
const warmSamples = samples.filter(sample => sample.at >= result.startedAt + 300_000);
const meanTime = warmSamples.reduce((sum, sample) => sum + (sample.at - result.startedAt) / 60000, 0) / warmSamples.length;
function memorySlope(field: string) {
  const mean = warmSamples.reduce((sum, sample) => sum + sample[field] / 1048576, 0) / warmSamples.length;
  return warmSamples.reduce((sum, sample) => sum + ((sample.at - result.startedAt) / 60000 - meanTime) * (sample[field] / 1048576 - mean), 0) / warmSamples.reduce((sum, sample) => sum + ((sample.at - result.startedAt) / 60000 - meanTime) ** 2, 0);
}
const slope = memorySlope('rss'), heapSlope = memorySlope('heapUsed');
assertions.rawLatencyIntegrity = bytes.length % 8 === 0 && latencies.length === result.acknowledged && latencies.every((value, index) => Number.isFinite(value) && value >= 0 && (!index || value >= latencies[index - 1]!));
assertions.rawP95Matches = p95 === result.roundTripMs.p95;
assertions.rawSamplesMatch = JSON.stringify(samples) === JSON.stringify(result.samples);
assertions.samplesMonotonic = samples.every((sample, index) => !index || (sample.at > samples[index - 1].at && sample.changes >= samples[index - 1].changes && sample.awarenessMessages >= samples[index - 1].awarenessMessages));
assertions.fullDuration = result.measuredSeconds >= 1800 && result.config.durationSeconds >= 1800;
assertions.fullSamplingCoverage = samples.length >= Math.floor(result.config.durationSeconds / 5) && samples[0]?.at - result.startedAt < 10000 && samples.at(-1)?.at >= result.endedAt && samples.every(sample => sample.elapsedMs > 0 && sample.elapsedMs < 10000);
assertions.exactWorkload = result.config.clientCount === 40 && result.config.opsPerSecond === 5 && result.config.cursorHz === 20 && result.operations === result.config.durationSeconds * 40 * 5 && result.cursorUpdates === result.config.durationSeconds * 40 * 20;
assertions.everyOperationAcknowledged = result.operations === result.acknowledged && result.disconnects === 0;
if (result.maxSchedulerLagMs !== undefined) assertions.schedulerCadence = Number.isFinite(result.maxSchedulerLagMs) && result.maxSchedulerLagMs <= 1000 && result.workers.every((worker: any) => Number.isFinite(worker.maxSchedulerLagMs) && worker.maxSchedulerLagMs <= 1000);
if (result.documentUpdates !== undefined) assertions.everyPacketAcknowledged = result.documentUpdates === result.documentAcknowledgements && result.workers.every((worker: any) => worker.pendingPackets === 0);
assertions.serverObservedWorkload = samples.at(-1)?.changes === (result.documentUpdates ?? result.operations) && samples.at(-1)?.awarenessMessages >= result.cursorUpdates;
assertions.latency = p95 !== undefined && p95 < 150;
assertions.cpu = samples.length > 0 && samples.every(sample => Number.isFinite(sample.cpuPctOneCore) && sample.cpuPctOneCore >= 0 && sample.cpuPctOneCore < 70);
assertions.memorySlope = Number.isFinite(slope) && Math.abs(slope) < 1 && slope === result.memory.rssSlopeMiBPerMinuteAfterWarmup && result.memory.warmupSeconds === 300;
if (result.memory.heapSlopeMiBPerMinuteAfterWarmup !== undefined) assertions.heapSlope = Number.isFinite(heapSlope) && Math.abs(heapSlope) < 1 && heapSlope === result.memory.heapSlopeMiBPerMinuteAfterWarmup;
assertions.clientAndServerConvergence = result.converged && result.clientHashes.length === 40 && result.snapshot.documents.length === 1 && result.clientHashes.every((hash: string) => hash === result.snapshot.documents[0].hash);
assertions.completeRecord = events.some(event => event.type === 'complete') && !events.some(event => event.type === 'failed');
if (result.config.production) assertions.persistedStateConverges = result.snapshot.documents.every((document: any) => document.persistenceMatches && document.persistedHash === document.hash);
if (result.config.clientProcesses) assertions.cleanProcessShutdown = events.filter(event => event.type === 'process-exit').length === result.config.clientProcesses + 1 && events.filter(event => event.type === 'process-exit').every(event => event.code === 0 && event.signal === null);
if (result.sourceHashes) {
  const archive = JSON.parse(readFileSync(file.replace(/\.json$/, '.sources.json'), 'utf8'));
  assertions.archivedSourceIntegrity = JSON.stringify(archive.sha256) === JSON.stringify(result.sourceHashes) && Object.entries(result.sourceHashes).every(([path, expected]) => typeof archive.sources[path] === 'string' && createHash('sha256').update(archive.sources[path]).digest('hex') === expected);
}
const passed = Object.values(assertions).every(Boolean);
console.log(JSON.stringify({ file, passed, assertions, note: 'The raw memory trace and scheduling gaps still need human review; this verifier cannot certify production server features or unbounded-content memory.' }, null, 2));
if (!passed) process.exitCode = 1;
