import { createRenderer } from '@whiteboard/renderer';
import { createElement } from '@whiteboard/model';
import type { Element } from '@whiteboard/model';

interface Scenario {
  name: string; shapes: number; strokes: number; texts: number; offscreenTexts?: number;
  sampleFrames?: number; warmupFrames?: number; minFps?: number;
}
const canvas = document.querySelector('canvas')!;
const status = document.querySelector('#status')!;
const renderer = createRenderer({ canvas, fontUrl: '/fonts/inter-latin-400-normal.woff',
  monoFontUrl: '/fonts/ibm-plex-mono-latin-400-normal.woff', pixelRatio: 1, background: '#f8fafc' });
let running = false;
const colors = ['#dbeafe', '#e0e7ff', '#fef3c7', '#dcfce7', '#fce7f3', '#f1f5f9'];
const scenarios: Scenario[] = [
  { name: 'mixed-5000-2000-500', shapes: 5000, strokes: 2000, texts: 500, minFps: 55 },
  { name: 'shapes-20000', shapes: 20000, strokes: 0, texts: 0, minFps: 30 },
  { name: 'visible-texts-500', shapes: 0, strokes: 0, texts: 500, minFps: 55 },
  { name: 'offscreen-texts-baseline', shapes: 5000, strokes: 0, texts: 0, offscreenTexts: 0, minFps: 55 },
  { name: 'offscreen-texts-5000', shapes: 5000, strokes: 0, texts: 0, offscreenTexts: 5000, minFps: 55 },
];

function fixture(config: Scenario): Element[] {
  const elements: Element[] = [];
  for (let i = 0; i < config.shapes; i++) {
    const columns = config.shapes > 5000 ? 200 : 100;
    const rows = Math.ceil(config.shapes / columns), cellW = 1600 / columns, cellH = 800 / rows;
    const type = (['rect', 'ellipse', 'sticky'] as const)[i % 3]!;
    const common = {
      id: `shape-${i}`, index: `a0${String(i).padStart(6, '0')}V`, x: 100 + i % columns * cellW, y: 100 + Math.floor(i / columns) * cellH,
      w: cellW * .75, h: cellH * .7, rotation: (i % 7 - 3) * .02,
      style: { fill: colors[i % colors.length]!, stroke: '#64748b', strokeWidth: .8 },
    };
    elements.push(type === 'sticky' ? createElement('sticky', { ...common, props: { text: '', autoSize: false, align: 'left' } })
      : type === 'rect' ? createElement('rect', common) : createElement('ellipse', common));
  }
  for (let i = 0; i < config.strokes; i++) {
    const x = 100 + i % 80 * 20, y = 100 + Math.floor(i / 80) * 32;
    const points: number[] = [];
    for (let p = 0; p < 16; p++) points.push(x + p, y + Math.sin(p / 3 + i) * 5, .25 + p / 24);
    elements.push(createElement('stroke', { id: `stroke-${i}`, index: `a0${String(config.shapes + i).padStart(6, '0')}V`,
      style: { stroke: '#475569', strokeWidth: 1.1 }, props: { points, simplified: false } }));
  }
  for (let i = 0; i < config.texts + (config.offscreenTexts ?? 0); i++) {
    const offscreen = i >= config.texts;
    elements.push(createElement('text', { id: `text-${i}`, index: `a0${String(config.shapes + config.strokes + i).padStart(6, '0')}V`,
      x: (offscreen ? 100000 : 150) + i % 25 * 61, y: 120 + Math.floor(i / 25) * 38,
      style: { color: '#172033', fontSize: 12 }, props: { text: `Note ${i % 100}`, align: 'left', autoSize: true } }));
  }
  return elements;
}

function resize(): void { renderer.resize(canvas.clientWidth, canvas.clientHeight); }
addEventListener('resize', resize); resize();
const nextFrame = () => new Promise<number>(resolve => requestAnimationFrame(resolve));
const quantile = (values: number[], proportion: number) => [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * proportion)] ?? 0;
function cameraAt(frame: number): void {
  renderer.setCamera({ x: 900 + Math.sin(frame / 70) * 24, y: 500 + Math.cos(frame / 95) * 18,
    zoom: Math.min(canvas.clientWidth / 1850, canvas.clientHeight / 1050) });
}

async function run(config: Scenario = scenarios[0]!) {
  if (running) throw new Error('A benchmark is already running');
  running = true;
  try {
    status.textContent = `Preparing ${config.name}…`;
    const setupStart = performance.now(); renderer.setElements(fixture(config)); cameraAt(0); await renderer.whenReady(); renderer.render();
    const setupMs = performance.now() - setupStart;
    for (let i = 0; i < (config.warmupFrames ?? 90); i++) { await nextFrame(); cameraAt(i); renderer.render(); }
    status.textContent = `Measuring ${config.name}…`;
    const frames: number[] = [], renderTimes: number[] = [];
    let previous = await nextFrame(), minVisibleTexts = Infinity, maxVisibleTexts = 0;
    const sampleFrames = config.sampleFrames ?? 600;
    const start = previous;
    for (let i = 0; i < sampleFrames; i++) {
      const now = await nextFrame(); frames.push(now - previous); previous = now;
      const renderStart = performance.now(); cameraAt(i); renderer.render(); renderTimes.push(performance.now() - renderStart);
      const visible = renderer.stats().visibleTexts; minVisibleTexts = Math.min(minVisibleTexts, visible); maxVisibleTexts = Math.max(maxVisibleTexts, visible);
    }
    const gl = renderer.webgl.getContext(), debug = gl.getExtension('WEBGL_debug_renderer_info');
    const fps = sampleFrames * 1000 / (previous - start);
    const result = {
      name: config.name, config, fps, meetsFps: fps >= (config.minFps ?? 55),
      elapsedMs: previous - start, setupMs, sampleFrames, warmupFrames: config.warmupFrames ?? 90,
      frameMs: { median: quantile(frames, .5), p95: quantile(frames, .95), max: Math.max(...frames) },
      renderCpuMs: { median: quantile(renderTimes, .5), p95: quantile(renderTimes, .95), max: Math.max(...renderTimes) },
      minVisibleTexts, maxVisibleTexts, stats: renderer.stats(),
      environment: { userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency,
        canvasWidth: canvas.width, canvasHeight: canvas.height, pixelRatio: renderer.webgl.getPixelRatio(),
        gpu: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
        maxTextureSize: renderer.webgl.capabilities.maxTextureSize },
      timestamp: new Date().toISOString(),
    };
    status.textContent = `${config.name}: ${fps.toFixed(1)} fps · ${result.stats.calls} calls`;
    console.log('S1_RESULT', JSON.stringify(result)); return result;
  } finally { running = false; }
}

async function runSuite(options: { sampleFrames?: number; warmupFrames?: number } = {}) {
  const results = [];
  for (const config of scenarios) results.push(await run({ ...config, ...options }));
  const baseline = results[3]!, culled = results[4]!;
  const culling = { noOffscreenTextMeshes: culled.stats.textInstances === 0, noExtraDrawCalls: culled.stats.calls === baseline.stats.calls,
    noExtraTriangles: culled.stats.triangles === baseline.stats.triangles,
    medianCpuDeltaMs: culled.renderCpuMs.median - baseline.renderCpuMs.median,
    p95CpuDeltaMs: culled.renderCpuMs.p95 - baseline.renderCpuMs.p95 };
  return { results, culling, passed: results.every(result => result.meetsFps) && results[0]!.minVisibleTexts === 500 && results[2]!.minVisibleTexts === 500 && culling.noOffscreenTextMeshes && culling.noExtraDrawCalls && culling.noExtraTriangles };
}

declare global { interface Window { rendererBenchmark: { run: typeof run; runSuite: typeof runSuite; scenarios: typeof scenarios; renderer: typeof renderer; fixture: typeof fixture; createRenderer: typeof createRenderer } } }
window.rendererBenchmark = { run, runSuite, scenarios, renderer, fixture, createRenderer };
document.querySelector('#run')!.addEventListener('click', () => void runSuite().then(result => console.log('S1_SUITE', JSON.stringify(result))));
cameraAt(0); renderer.render();
