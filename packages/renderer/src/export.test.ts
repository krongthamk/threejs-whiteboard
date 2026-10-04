import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import * as THREE from 'three';
import { ThreeRenderer } from './index';

vi.mock('three', async importOriginal => {
  const actual = await importOriginal<typeof import('three')>();
  class WebGLRenderer {
    domElement: HTMLCanvasElement;
    capabilities = { maxTextureSize: 16384 };
    info = { render: { calls: 0, triangles: 0 }, memory: { geometries: 0, textures: 0 } };
    target: THREE.WebGLRenderTarget | null = null;
    targets: THREE.WebGLRenderTarget[] = [];
    constructor(options: { canvas: HTMLCanvasElement }) { this.domElement = options.canvas; }
    setPixelRatio() {} getPixelRatio() { return 1; } setClearColor() {} setSize() {} render() {} dispose() {}
    getClearColor(color: THREE.Color) { return color.setRGB(1, 1, 1); } getClearAlpha() { return 1; }
    setRenderTarget(target: THREE.WebGLRenderTarget | null) { this.target = target; if (target) this.targets.push(target); }
    getRenderTarget() { return this.target; }
    setViewport = vi.fn();
    getContext() { return { isContextLost: () => false }; }
    readRenderTargetPixels(_target: THREE.WebGLRenderTarget, _x: number, _y: number, w: number, h: number, pixels: Uint8Array) { pixels.fill(255, 0, w * h * 4); }
  }
  return { ...actual, WebGLRenderer };
});
vi.mock('troika-three-text', () => ({ configureTextBuilder() {}, Text: class {}, getCaretAtPoint() {}, getSelectionRects() {} }));

let renderer: ThreeRenderer, canvas: HTMLCanvasElement;
let putImageData: ReturnType<typeof vi.fn>;
beforeEach(() => {
  putImageData = vi.fn();
  canvas = Object.assign(new EventTarget(), { clientWidth: 100, clientHeight: 100 }) as unknown as HTMLCanvasElement;
  vi.stubGlobal('document', { baseURI: 'http://localhost/', createElement: () => ({ width: 0, height: 0,
    getContext: () => ({ putImageData }), toBlob: (callback: BlobCallback) => callback(new Blob(['png'], { type: 'image/png' })) }) });
  vi.stubGlobal('ImageData', class { constructor(public data: Uint8ClampedArray, public width: number, public height: number) {} });
  renderer = new ThreeRenderer({ canvas, fontUrl: '/font.woff' });
});
afterEach(() => { renderer.dispose(); vi.unstubAllGlobals(); });
function targets(): THREE.WebGLRenderTarget[] { return (renderer.webgl as unknown as { targets: THREE.WebGLRenderTarget[] }).targets; }

test('PNG caps native tile allocation at 4096 and reuses one target across edge tiles', async () => {
  await renderer.exportPng({ bounds: { x: 0, y: 0, w: 4136, h: 48 }, scale: 1 });
  expect(targets()).toHaveLength(2);
  expect(new Set(targets()).size).toBe(1);
  expect(targets()[0]!.width).toBe(4096); expect(targets()[0]!.height).toBe(48);
  expect(putImageData.mock.calls.map(([image, x, y]) => [image.width, image.height, x, y])).toEqual([[4096, 48, 0, 0], [40, 48, 4096, 0]]);
});

test('two-axis small tiles retain fixed target storage and release it once', async () => {
  renderer.webgl.capabilities.maxTextureSize = 64;
  const dispose = vi.spyOn(THREE.WebGLRenderTarget.prototype, 'dispose');
  const readback = vi.spyOn(renderer.webgl, 'readRenderTargetPixels');
  try {
    await renderer.exportPng({ bounds: { x: 0, y: 0, w: 130, h: 134 }, scale: 1, transparent: true });
    expect(targets()).toHaveLength(9); expect(new Set(targets()).size).toBe(1);
    expect(targets()[0]!.width).toBe(64); expect(targets()[0]!.height).toBe(64);
    expect(putImageData.mock.calls.at(-1)!.slice(1)).toEqual([128, 128]);
    expect(putImageData.mock.calls.at(-1)![0].width).toBe(2); expect(putImageData.mock.calls.at(-1)![0].height).toBe(6);
    expect(new Set(readback.mock.calls.map(call => call[5].buffer)).size).toBe(1);
    expect(new Set(putImageData.mock.calls.map(([image]) => image.data.buffer)).size).toBe(1);
    expect(dispose).toHaveBeenCalledOnce(); expect(renderer.webgl.getRenderTarget()).toBe(null);
  } finally { dispose.mockRestore(); readback.mockRestore(); }
});

test('context loss interrupts pending tile readiness and cleans export resources', async () => {
  let finish!: () => void;
  const ready = vi.spyOn(renderer, 'whenReady').mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  const add = vi.spyOn(canvas, 'addEventListener'), remove = vi.spyOn(canvas, 'removeEventListener');
  const pending = renderer.exportPng({ bounds: { x: 0, y: 0, w: 130, h: 134 }, scale: 1 });
  canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
  try {
    const result = await Promise.race([pending.then(() => 'resolved', error => String(error)), new Promise<string>(resolve => setTimeout(() => resolve('still waiting'), 25))]);
    expect(result).toContain('graphics context');
    expect(add.mock.calls.some(([type]) => type === 'webglcontextlost')).toBe(true);
    expect(remove.mock.calls.some(([type]) => type === 'webglcontextlost')).toBe(true);
    expect(renderer.layers.selectionUI.visible).toBe(true); expect(renderer.webgl.getRenderTarget()).toBe(null);
  } finally { ready.mockRestore(); finish(); await pending.catch(() => {}); }
});

test('abort interrupts pending tile readiness without waiting for its producer', async () => {
  let finish!: () => void;
  const ready = vi.spyOn(renderer, 'whenReady').mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  const controller = new AbortController(), options = { bounds: { x: 0, y: 0, w: 130, h: 134 }, scale: 1, signal: controller.signal };
  const pending = renderer.exportPng(options); controller.abort();
  try {
    const result = await Promise.race([pending.then(() => 'resolved', error => error.name), new Promise<string>(resolve => setTimeout(() => resolve('still waiting'), 25))]);
    expect(result).toBe('AbortError'); expect(renderer.layers.selectionUI.visible).toBe(true); expect(renderer.webgl.getRenderTarget()).toBe(null);
  } finally { ready.mockRestore(); finish(); await pending.catch(() => {}); }
});
