import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { DEFAULT_STYLE, textBlock, textLayout, rotatePoint, type Element, type ElementOf, type ShapeTextProps } from '@whiteboard/model';
import { ThreeRenderer } from './index';
import { pngHeader } from '../../../tests/image-fixtures';

const textState = vi.hoisted(() => ({ failNext: false, instances: [] as unknown[] }));

vi.mock('three', async importOriginal => {
  const actual = await importOriginal<typeof import('three')>();
  class WebGLRenderer {
    capabilities = { maxTextureSize: 4096 };
    info = { render: { calls: 0, triangles: 0 }, memory: { geometries: 0, textures: 0 } };
    setPixelRatio() {} getPixelRatio() { return 1; } setClearColor() {} setSize() {} render = vi.fn(); dispose = vi.fn(); forceContextLoss = vi.fn();
  }
  return { ...actual, WebGLRenderer };
});
vi.mock('troika-three-text', async () => {
  const { Mesh, PlaneGeometry, MeshBasicMaterial } = await import('three');
  class Text extends Mesh {
    callbacks: (() => void)[] = [];
    constructor() { super(new PlaneGeometry(1, 1), new MeshBasicMaterial()); textState.instances.push(this); }
    sync(callback: () => void) { if (textState.failNext) { textState.failNext = false; throw new Error('sync failed'); } this.callbacks.push(callback); }
    dispose = vi.fn(() => this.geometry.dispose());
  }
  return { Text, configureTextBuilder() {}, getCaretAtPoint() {}, getSelectionRects() { return []; } };
});

function stroke(n: number): ElementOf<'stroke'> {
  return { id: `stroke-${n}`, type: 'stroke', index: String(n).padStart(6, '0'), x: n, y: 0, w: 30, h: 20, rotation: 0,
    style: { ...DEFAULT_STYLE }, props: { points: [0, 0, .5, 10, 10, .5, 30, 20, .5], simplified: true } };
}
function connector(id: string, target: string): ElementOf<'connector'> {
  return { ...stroke(0), id, type: 'connector', index: id, props: { start: { elementId: target, nx: 1, ny: .5, fallback: { x: 0, y: 0 } }, end: { x: 100, y: 100 }, kind: 'straight' } };
}
let renderer: ThreeRenderer;
beforeEach(() => {
  textState.instances = []; textState.failNext = false;
  vi.stubGlobal('document', { baseURI: 'http://localhost/' });
  renderer = new ThreeRenderer({ canvas: { clientWidth: 1000, clientHeight: 800 } as HTMLCanvasElement, fontUrl: '/font.woff' });
});
afterEach(() => { renderer.dispose(); vi.unstubAllGlobals(); });

function opaqueMeshes(): THREE.Mesh[] { return renderer.layers.strokes.children.filter(mesh => mesh instanceof THREE.Mesh && mesh.geometry.getAttribute('tint')) as THREE.Mesh[]; }
function depths(mesh: THREE.Mesh): number[] {
  const positions = mesh.geometry.getAttribute('position');
  return Array.from({ length: positions.count }, (_, i) => positions.getZ(i));
}

describe('incremental projection', () => {
  it('keeps full stroke chunks and unrelated connectors when adding one stroke', () => {
    renderer.setElements([...Array.from({ length: 768 }, (_, i) => stroke(i)), connector('z-first', 'stroke-0'), connector('z-second', 'stroke-700')]);
    const meshes = opaqueMeshes(), oldDepths = meshes.map(depths);
    const connectors = [...renderer.layers.connectors.children];
    const before = renderer.stats();
    renderer.applyDiff([stroke(768)]); renderer.render();
    expect(renderer.stats().strokeChunkRebuilds - before.strokeChunkRebuilds).toBe(1);
    expect(opaqueMeshes().slice(0, 3)).toEqual(meshes);
    expect(meshes.map(depths)).toEqual(oldDepths);
    expect(renderer.layers.connectors.children).toEqual(connectors);
  });

  it('early eraser deletion rebuilds its chunk, preserves later membership and only its dependent connector', () => {
    renderer.setElements([...Array.from({ length: 768 }, (_, i) => stroke(i)), connector('z-first', 'stroke-0'), connector('z-second', 'stroke-700')]);
    const meshes = opaqueMeshes();
    const connectors = renderer.layers.connectors.children.filter(mesh => !(mesh instanceof THREE.InstancedMesh));
    const arrows = renderer.layers.connectors.children.find(mesh => mesh instanceof THREE.InstancedMesh);
    const before = renderer.stats();
    renderer.applyDiff([], Array.from({ length: 10 }, (_, i) => `stroke-${i}`)); renderer.render();
    expect(renderer.stats().strokeChunkRebuilds - before.strokeChunkRebuilds).toBe(1);
    expect(opaqueMeshes()).toContain(meshes[1]); expect(opaqueMeshes()).toContain(meshes[2]);
    expect(renderer.layers.connectors.children).toContain(connectors[1]);
    expect(renderer.layers.connectors.children).toContain(arrows);
    expect(renderer.layers.connectors.children).not.toContain(connectors[0]);
    expect(renderer.stats().elements).toBe(760);
  });

  it('uses id ties and stable ranks when a translucent element is inserted and reordered', () => {
    const shape = (id: string): Element => ({ ...stroke(0), id, index: 'same', type: 'rect', props: {}, style: { ...DEFAULT_STYLE, opacity: .5 } });
    renderer.setElements([shape('c'), shape('a')]);
    const [a, c] = [...renderer.layers.shapes.children].filter(mesh => mesh instanceof THREE.InstancedMesh) as THREE.InstancedMesh[];
    expect(a!.renderOrder).toBeLessThan(c!.renderOrder);
    renderer.applyDiff([shape('b')]); renderer.render();
    const instances = renderer.layers.shapes.children.filter(mesh => mesh instanceof THREE.InstancedMesh) as THREE.InstancedMesh[];
    expect(instances).toContain(a); expect(instances).toContain(c);
    const b = instances.find(mesh => mesh !== a && mesh !== c)!;
    expect(b.renderOrder).toBeGreaterThan(a!.renderOrder); expect(b.renderOrder).toBeLessThan(c!.renderOrder);
    renderer.applyDiff([{ ...shape('b'), index: 'zz' }]); renderer.render();
    expect((renderer.layers.shapes.children.at(-1) as THREE.Mesh).renderOrder).toBeGreaterThan(c!.renderOrder);
  });
});


function note(): ElementOf<'sticky'> {
  return { ...stroke(0), id: 'note', type: 'sticky', index: 'middle', w: 200, h: 180,
    props: { text: 'Ready text', align: 'left', autoSize: false } };
}
type MockText = THREE.Mesh & { callbacks: (() => void)[]; dispose: ReturnType<typeof vi.fn> };
function latestText(): MockText { return textState.instances.at(-1) as MockText; }
async function readyNote(): Promise<MockText> {
  renderer.setElements([note()]); renderer.render();
  const mesh = latestText(); mesh.callbacks.shift()!(); await renderer.whenReady(); return mesh;
}

describe('text handle lifetime', () => {
  it('retains the ready mesh through transform, order, opacity and color changes with zero disposals', async () => {
    const mesh = await readyNote(), before = renderer.stats();
    const next = { ...note(), x: 80, y: 90, h: 220, rotation: .5, index: 'z', style: { ...DEFAULT_STYLE, color: '#ff0000', opacity: .5 } };
    renderer.applyDiff([next]); renderer.render();
    expect(renderer.getTextObject('note')).toBe(mesh);
    expect(mesh.visible).toBe(true); expect(mesh.rotation.z).toBe(-.5);
    expect(mesh.position.x).not.toBe(16); expect(mesh.dispose).not.toHaveBeenCalled();
    expect(renderer.stats().textDisposals - before.textDisposals).toBe(0);
    expect(renderer.stats().pendingTexts).toBe(0);
    expect(renderer.layers.text.children.filter(child => child !== mesh && child.visible)).toEqual([]);
  });

  it('keeps old ready text visible until the replacement layout is ready and then disposes it once', async () => {
    const old = await readyNote();
    renderer.applyDiff([{ ...note(), w: 100, props: { ...note().props, text: 'Changed layout' } }]); renderer.render();
    const replacement = latestText();
    expect(replacement).not.toBe(old); expect(renderer.getTextObject('note')).toBe(old);
    expect(old.visible).toBe(true); expect(old.parent).toBe(renderer.layers.text);
    expect(old.dispose).not.toHaveBeenCalled();
    expect(renderer.layers.text.children.filter(child => child !== old && child.visible)).toEqual([]);
    replacement.callbacks.shift()!(); await renderer.whenReady();
    expect(renderer.getTextObject('note')).toBe(replacement); expect(replacement.visible).toBe(true);
    expect(old.dispose).toHaveBeenCalledOnce(); expect(old.parent).toBe(null);
  });

  it('deleting during relayout cleans both handles and late sync cannot resurrect them', async () => {
    const old = await readyNote();
    renderer.applyDiff([{ ...note(), style: { ...DEFAULT_STYLE, fontSize: 30 } }]); renderer.render();
    const replacement = latestText(), callback = replacement.callbacks.shift()!;
    renderer.applyDiff([], ['note']); renderer.render(); await renderer.whenReady(); callback();
    expect(old.dispose).toHaveBeenCalledOnce(); expect(replacement.dispose).toHaveBeenCalledOnce();
    expect(renderer.getTextObject('note')).toBeUndefined(); expect(renderer.layers.text.children).toEqual([]);
    expect(renderer.stats().pendingTexts).toBe(0);
  });

  it('failed replacement releases the new mesh, retains ready text, reports failure and permits retry', async () => {
    const old = await readyNote(); textState.failNext = true;
    renderer.applyDiff([{ ...note(), w: 90 }]); renderer.render();
    const failed = latestText();
    await expect(renderer.whenReady()).rejects.toThrow('sync failed');
    expect(renderer.getTextObject('note')).toBe(old); expect(old.visible).toBe(true);
    expect(failed.dispose).toHaveBeenCalledOnce(); expect(old.dispose).not.toHaveBeenCalled();
    expect(renderer.stats().textErrors).toBe(1);
    renderer.applyDiff([{ ...note(), w: 100 }]); renderer.render();
    latestText().callbacks.shift()!(); await renderer.whenReady();
    expect(renderer.stats().textErrors).toBe(0); expect(old.dispose).toHaveBeenCalledOnce();
  });
});


it('repeated equal-index insertions retain strict primitive and text depth order through rank renormalization', async () => {
  const makeNote = (id: string): ElementOf<'sticky'> => ({ ...note(), id, index: 'same', style: { ...DEFAULT_STYLE, opacity: .5 } });
  renderer.setElements([makeNote('a'), makeNote('z')]); renderer.render();
  for (const mesh of textState.instances as MockText[]) mesh.callbacks.shift()!(); await renderer.whenReady();
  let last = 'b';
  const ids = ['a', 'z'];
  for (let i = 0; i < 16; i++) {
    const id = last + 'a'; last = id; ids.push(id);
    renderer.applyDiff([makeNote(id)]); renderer.render(); latestText().callbacks.shift()!(); await renderer.whenReady();
    const ordered = [...renderer.layers.shapes.children].filter(mesh => mesh instanceof THREE.InstancedMesh)
      .sort((a, b) => a.renderOrder - b.renderOrder);
    const fillDepth = ordered.map(mesh => mesh.renderOrder - 1000);
    const textDepth = [...renderer.layers.text.children].filter(mesh => mesh.visible).map(mesh => mesh.position.z).sort((a, b) => a - b);
    expect(textDepth).toHaveLength(fillDepth.length);
    expect([...ids].sort().map(id => renderer.getTextObject(id)!.position.z)).toEqual(textDepth);
    for (let j = 0; j < fillDepth.length; j++) {
      expect(textDepth[j]!).toBeGreaterThan(fillDepth[j]!);
      if (j + 1 < fillDepth.length) expect(textDepth[j]!).toBeLessThan(fillDepth[j + 1]!);
    }
  }
});

it('a transform retries a transient replacement failure while retaining the ready old display', async () => {
  const old = await readyNote(); textState.failNext = true;
  const resized = { ...note(), w: 90 };
  renderer.applyDiff([resized]); renderer.render(); await expect(renderer.whenReady()).rejects.toThrow('sync failed');
  const failed = latestText();
  renderer.applyDiff([{ ...resized, x: 30 }]); renderer.render();
  const retry = latestText();
  expect(retry).not.toBe(failed); expect(renderer.getTextObject('note')).toBe(old); expect(old.visible).toBe(true);
  retry.callbacks.shift()!(); await renderer.whenReady(); expect(renderer.getTextObject('note')).toBe(retry);
  expect(renderer.stats().textErrors).toBe(0);
});

it('a transform retries a transient initial layout failure', async () => {
  textState.failNext = true; renderer.setElements([note()]); renderer.render();
  await expect(renderer.whenReady()).rejects.toThrow('sync failed'); const failed = latestText();
  renderer.applyDiff([{ ...note(), x: 30 }]); renderer.render(); const retry = latestText();
  expect(retry).not.toBe(failed); expect(failed.dispose).toHaveBeenCalledOnce();
  retry.callbacks.shift()!(); await renderer.whenReady(); expect(renderer.stats().textErrors).toBe(0);
});

it('opaque connector arrowheads share one draw mesh and update only stable affected slots', () => {
  const connectors = Array.from({ length: 100 }, (_, i) => {
    const element = connector(`z-${String(i).padStart(3, '0')}`, `stroke-${i}`);
    return { ...element, props: { ...element.props, end: { x: 100 + i * 4, y: 100 } } };
  });
  renderer.setElements([...Array.from({ length: 100 }, (_, i) => stroke(i)), ...connectors]); renderer.render();
  const arrows = renderer.layers.connectors.children.filter(mesh => mesh instanceof THREE.InstancedMesh) as THREE.InstancedMesh[];
  expect(arrows).toHaveLength(1); // One arrow draw call, regardless of connector count.
  const batch = arrows[0]!, matrices = batch.instanceMatrix, tints = batch.geometry.getAttribute('tint') as THREE.InstancedBufferAttribute;
  expect(batch.count).toBe(100);
  const original = Array.from(matrices.array), originalTint = Array.from(tints.array);
  matrices.clearUpdateRanges(); tints.clearUpdateRanges();
  renderer.applyDiff([{ ...stroke(1), x: 60 }]); renderer.render();
  expect(renderer.layers.connectors.children).toContain(batch);
  expect(batch.instanceMatrix).toBe(matrices); expect(batch.geometry.getAttribute('tint')).toBe(tints);
  expect(matrices.updateRanges).toEqual([{ start: 16, count: 16 }]);
  expect(tints.updateRanges).toEqual([{ start: 4, count: 4 }]);
  expect(Array.from(matrices.array).slice(32)).toEqual(original.slice(32));
  expect(Array.from(tints.array).slice(8)).toEqual(originalTint.slice(8));
  expect(Array.from(matrices.array).slice(16, 32)).not.toEqual(original.slice(16, 32));
  matrices.clearUpdateRanges(); tints.clearUpdateRanges();
  renderer.applyDiff([], [connectors[0]!.id]); renderer.render();
  expect(renderer.layers.connectors.children).toContain(batch);
  expect(matrices.updateRanges).toEqual([{ start: 0, count: 16 }]);
  expect(Array.from(matrices.array).slice(32)).toEqual(original.slice(32));
  renderer.applyDiff([connector('z-new', 'stroke-99')]); renderer.render();
  expect(renderer.layers.connectors.children).toContain(batch); expect(batch.count).toBe(100);
});

it('opaque arrow capacity grows geometrically and preserves every existing slot', () => {
  const elements = Array.from({ length: 16 }, (_, i) => connector(`z-${String(i).padStart(3, '0')}`, 'missing'));
  renderer.setElements(elements); renderer.render();
  const before = renderer.layers.connectors.children.find(mesh => mesh.name === 'opaqueConnectorArrowheads') as THREE.InstancedMesh;
  expect(before.instanceMatrix.count).toBe(16);
  const matrices = Array.from(before.instanceMatrix.array), tint = Array.from(before.geometry.getAttribute('tint').array);
  renderer.applyDiff([connector('z-new', 'missing')]); renderer.render();
  const after = renderer.layers.connectors.children.find(mesh => mesh.name === 'opaqueConnectorArrowheads') as THREE.InstancedMesh;
  expect(after).not.toBe(before); expect(after.instanceMatrix.count).toBe(32); expect(after.count).toBe(17);
  expect(Array.from(after.instanceMatrix.array).slice(0, matrices.length)).toEqual(matrices);
  expect(Array.from(after.geometry.getAttribute('tint').array).slice(0, tint.length)).toEqual(tint);
  expect(before.parent).toBe(null);
});

it('translucent connectors remain independently ordered while opaque arrow slots survive material transitions', () => {
  const a = connector('z-a', 'missing'), b = connector('z-b', 'missing');
  const c = { ...connector('z-c', 'missing'), style: { ...DEFAULT_STYLE, opacity: .5 } };
  renderer.setElements([a, b, c]); renderer.render();
  const batch = renderer.layers.connectors.children.find(mesh => mesh.name === 'opaqueConnectorArrowheads') as THREE.InstancedMesh;
  const transparentArrows = renderer.layers.connectors.children.filter(mesh => mesh instanceof THREE.InstancedMesh && mesh !== batch) as THREE.InstancedMesh[];
  expect(transparentArrows).toHaveLength(1); expect(transparentArrows[0]!.renderOrder).toBeGreaterThan(1000 - 100);
  const unchanged = new THREE.Matrix4(); batch.getMatrixAt(1, unchanged);
  renderer.applyDiff([{ ...a, style: { ...DEFAULT_STYLE, opacity: .5 } }]); renderer.render();
  expect(renderer.layers.connectors.children).toContain(batch);
  const after = new THREE.Matrix4(); batch.getMatrixAt(1, after); expect(after.elements).toEqual(unchanged.elements);
  const translucent = renderer.layers.connectors.children.filter(mesh => mesh instanceof THREE.InstancedMesh && mesh !== batch) as THREE.InstancedMesh[];
  expect(translucent).toHaveLength(2);
  expect(translucent.map(mesh => mesh.renderOrder).sort((left, right) => left - right)[0]).toBeLessThan(transparentArrows[0]!.renderOrder);
  renderer.applyDiff([], [b.id]); renderer.render();
  expect(renderer.layers.connectors.children).not.toContain(batch);
  expect(renderer.layers.connectors.children.filter(mesh => mesh instanceof THREE.InstancedMesh)).toHaveLength(2);
});

it('append, complete early-chunk deletion and highest deletion preserve surviving projections and allow another append', async () => {
  const sticky = { ...note(), id: 'sticky', index: 'zz' };
  renderer.setElements([...Array.from({ length: 260 }, (_, i) => stroke(i)), connector('z-bound', 'stroke-0'), sticky]); renderer.render();
  const text = latestText(); text.callbacks.shift()!(); await renderer.whenReady();
  const oldChunks = opaqueMeshes(), firstDepths = depths(oldChunks[0]!);
  const shape = renderer.layers.shapes.children.find(mesh => mesh instanceof THREE.InstancedMesh);
  renderer.applyDiff([{ ...stroke(260), index: 'zzz' }]); renderer.render();
  expect(opaqueMeshes()).toContain(oldChunks[0]); expect(depths(oldChunks[0]!)).toEqual(firstDepths);
  expect(renderer.layers.shapes.children).toContain(shape); expect(renderer.getTextObject('sticky')).toBe(text);
  const tail = opaqueMeshes().find(mesh => mesh !== oldChunks[0])!;
  const textDepth = renderer.getTextObject('sticky')!.position.z;
  expect(Math.max(...depths(tail))).toBeGreaterThan(textDepth);
  renderer.applyDiff([], Array.from({ length: 256 }, (_, i) => `stroke-${i}`)); renderer.render();
  expect(opaqueMeshes()).toHaveLength(1); expect(opaqueMeshes()[0]).toBe(tail);
  renderer.applyDiff([], ['stroke-260']); renderer.render(); // Removes the maximum: general ordering path.
  expect(renderer.getTextObject('sticky')).toBe(text);
  const before = renderer.stats();
  renderer.applyDiff([{ ...stroke(261), index: 'zzzz' }]); renderer.render();
  expect(renderer.stats().strokeChunkRebuilds - before.strokeChunkRebuilds).toBe(1);
  expect(renderer.getTextObject('sticky')).toBe(text); expect(text.visible).toBe(true);
  expect(renderer.stats().elements).toBe(7);
});

it('append and middle insertion respect equal-index id order, including a subsequent material transition', () => {
  const ink = (id: string, color: string): ElementOf<'stroke'> => ({ ...stroke(0), id, index: 'same', style: { ...DEFAULT_STYLE, stroke: color } });
  const depthFor = (rgb: number[]): number => {
    for (const mesh of opaqueMeshes()) {
      const tint = mesh.geometry.getAttribute('tint'), positions = mesh.geometry.getAttribute('position');
      for (let i = 0; i < tint.count; i++) if (tint.getX(i) === rgb[0] && tint.getY(i) === rgb[1] && tint.getZ(i) === rgb[2]) return positions.getZ(i);
    }
    throw new Error('Missing expected stroke color');
  };
  renderer.setElements([ink('a', '#ff0000')]);
  renderer.applyDiff([ink('z', '#0000ff')]); renderer.render(); // Equal index, above current maximum by ID.
  expect(depthFor([1, 0, 0])).toBeLessThan(depthFor([0, 0, 1]));
  renderer.applyDiff([ink('m', '#00ff00')]); renderer.render(); // Mid-order insertion requires ordered path.
  expect(depthFor([1, 0, 0])).toBeLessThan(depthFor([0, 1, 0])); expect(depthFor([0, 1, 0])).toBeLessThan(depthFor([0, 0, 1]));
  renderer.applyDiff([{ ...ink('m', '#00ff00'), style: { ...DEFAULT_STYLE, stroke: '#00ff00', opacity: .5 } }]); renderer.render();
  expect(renderer.stats().elements).toBe(3); expect(renderer.stats().strokeChunks).toBe(1);
  const translucent = renderer.layers.strokes.children.filter(mesh => mesh instanceof THREE.Mesh && mesh.geometry.getAttribute('tint') && (mesh.material as THREE.ShaderMaterial).transparent) as THREE.Mesh[];
  expect(translucent).toHaveLength(1);
  const translucentDepth = translucent[0]!.renderOrder - 1000;
  expect(depthFor([1, 0, 0])).toBeLessThan(translucentDepth); expect(translucentDepth).toBeLessThan(depthFor([0, 0, 1]));
});

it('repeated eraser preview removals preserve the already updated dependent connector', () => {
  renderer.setElements([stroke(0), stroke(1), connector('z-bound', 'stroke-0')]);
  renderer.applyDiff([], ['stroke-0']); renderer.render();
  const before = renderer.stats(), meshes = [...renderer.layers.connectors.children];
  renderer.applyDiff([], ['stroke-0']); renderer.render();
  expect(renderer.stats().connectorRebuilds - before.connectorRebuilds).toBe(0);
  expect(renderer.layers.connectors.children).toEqual(meshes);
});


describe('render invalidation', () => {
  function draws() { return vi.mocked(renderer.webgl.render).mock.calls.length; }
  function oneDraw(change: () => void) {
    const before = draws(); change(); renderer.render(false);
    expect(draws()).toBe(before + 1);
    renderer.render(false); renderer.render(false); expect(draws()).toBe(before + 1);
  }
  it('skips idle frames and draws every synchronous document and overlay trigger', () => {
    renderer.render(false); const before = draws();
    for (let i = 0; i < 60; i++) renderer.render(false);
    expect(draws()).toBe(before);
    renderer.render(); expect(draws()).toBe(before + 1); // Explicit draw preserves direct scene/WebGL consumers.
    renderer.render(false); expect(draws()).toBe(before + 1);
    renderer.applyDiff([]); renderer.render(false); expect(draws()).toBe(before + 1);
    oneDraw(() => { renderer.applyDiff([stroke(0)]); renderer.applyDiff([stroke(1)]); });
    oneDraw(() => renderer.setElements([stroke(0)]));
    oneDraw(() => renderer.applyDiff([stroke(1)]));
    oneDraw(() => renderer.applyDiff([], ['stroke-0']));
    oneDraw(() => renderer.setCamera({ x: 10, y: 20, zoom: 2 }));
    oneDraw(() => renderer.resize(800, 600));
    oneDraw(() => renderer.setSelection({ marquee: { x: 0, y: 0, w: 30, h: 40 } }));
    oneDraw(() => renderer.setLiveStroke(stroke(2)));
    oneDraw(() => renderer.setLiveStroke(null));
    oneDraw(() => renderer.setEditingText('note'));
    oneDraw(() => renderer.setEditingText(null));
    oneDraw(() => renderer.setPresence([]));
    oneDraw(() => renderer.setElements([]));
  });
  it('document and presence glyph completion each wake an otherwise idle renderer', async () => {
    renderer.setElements([note()]); renderer.render(false); const text = latestText();
    oneDraw(() => text.callbacks.shift()!()); await renderer.whenReady();
    renderer.applyDiff([{ ...note(), w: 150 }]); renderer.render(false); const replacement = latestText();
    oneDraw(() => replacement.callbacks.shift()!()); await renderer.whenReady();
    const peer = { clientId: 'peer', name: 'Alice', color: '#4378ed', cursor: { x: 10, y: 10 }, selection: ['note'], editingTextId: 'note' };
    oneDraw(() => renderer.setPresence([peer]));
    for (const label of (textState.instances as MockText[]).slice(-2)) oneDraw(() => label.callbacks.shift()!());
    oneDraw(() => renderer.setPresence([{ ...peer, cursor: { x: 20, y: 20 } }]));
    oneDraw(() => renderer.setPresence([]));
  });
  it('asynchronous image texture binding and failure each wake an otherwise idle renderer', async () => {
    renderer.dispose();
    const fetchImage = vi.fn(async () => new Response(new Blob([pngHeader(10, 10) as Uint8Array<ArrayBuffer>], { type: 'image/png' })));
    vi.stubGlobal('fetch', fetchImage);
    let finishDecode!: (bitmap: ImageBitmap) => void;
    vi.stubGlobal('createImageBitmap', vi.fn(() => new Promise<ImageBitmap>(resolve => { finishDecode = resolve; })));
    renderer = new ThreeRenderer({ canvas: { clientWidth: 1000, clientHeight: 800 } as HTMLCanvasElement, fontUrl: '/font.woff', resolveAsset: id => `/asset/${id}` });
    const image: ElementOf<'image'> = { ...stroke(0), id: 'image', type: 'image', props: { assetId: 'asset', naturalW: 10, naturalH: 10 } };
    renderer.setElements([image]); renderer.render(false);
    await vi.waitFor(() => expect(finishDecode).toBeDefined());
    renderer.render(false); const before = draws(); renderer.render(false); expect(draws()).toBe(before);
    finishDecode({ width: 10, height: 10, close: vi.fn() } as unknown as ImageBitmap);
    await renderer.whenReady(); renderer.render(false); expect(draws()).toBe(before + 1);
    renderer.render(false); expect(draws()).toBe(before + 1);
    fetchImage.mockRejectedValueOnce(new Error('missing image'));
    renderer.setElements([{ ...image, props: { ...image.props, assetId: 'failed' } }]); renderer.render(false);
    const failedBefore = draws(); await expect(renderer.whenReady()).rejects.toThrow('missing image');
    renderer.render(false); expect(draws()).toBe(failedBefore + 1);
    renderer.render(false); expect(draws()).toBe(failedBefore + 1);
  });
});


describe('bounded offscreen text cache', () => {
  const regional = (n: number): ElementOf<'sticky'> => ({ ...note(), id: `region-${n}`, x: n * 2000 });
  async function visit(n: number): Promise<MockText> {
    renderer.setCamera({ x: n * 2000, y: 0, zoom: 1 }); renderer.render();
    const mesh = renderer.getTextObject(`region-${n}`) as unknown as MockText;
    mesh.callbacks.shift()?.(); await renderer.whenReady(); return mesh;
  }
  function regions(cap = 2) {
    renderer.dispose();
    renderer = new ThreeRenderer({ canvas: { clientWidth: 1000, clientHeight: 800 } as HTMLCanvasElement, fontUrl: '/font.woff', offscreenTextCacheSize: cap });
    renderer.setElements(Array.from({ length: 7 }, (_, n) => regional(n)));
  }
  it('evicts the least recently visited offscreen handle while keeping recent and visible handles', async () => {
    regions(); const zero = await visit(0), one = await visit(1);
    expect(await visit(0)).toBe(zero); await visit(2); await visit(3);
    expect(renderer.stats().textInstances).toBe(3);
    expect(renderer.getTextObject('region-1')).toBeUndefined(); expect(one.dispose).toHaveBeenCalledOnce();
    expect(renderer.getTextObject('region-0')).toBe(zero); expect(zero.dispose).not.toHaveBeenCalled();
    const recreated = await visit(1); expect(recreated).not.toBe(one); expect(recreated.visible).toBe(true);
  });
  it('pins edited text even outside the viewport and releases it when editing ends', async () => {
    regions(0); const zero = await visit(0); renderer.setEditingText('region-0'); await visit(1); await visit(2);
    expect(renderer.getTextObject('region-0')).toBe(zero); expect(zero.dispose).not.toHaveBeenCalled();
    renderer.setEditingText(null); renderer.render(); await renderer.whenReady();
    expect(renderer.getTextObject('region-0')).toBeUndefined(); expect(zero.dispose).toHaveBeenCalledOnce();
  });
  it('eviction cancels both active and replacement layouts and late sync cannot resurrect them', async () => {
    regions(0); const zero = await visit(0);
    renderer.applyDiff([{ ...regional(0), props: { ...regional(0).props, text: 'Pending replacement' } }]); renderer.render();
    const replacement = latestText(); await visit(1);
    expect(zero.dispose).toHaveBeenCalledOnce(); expect(replacement.dispose).toHaveBeenCalledOnce();
    replacement.callbacks.shift()?.(); await Promise.resolve();
    expect(renderer.getTextObject('region-0')).toBeUndefined(); expect(renderer.stats().pendingTexts).toBe(0);
  });
});

it('disposal releases WebGL resources and loses the context exactly once', () => {
  renderer.dispose(); renderer.dispose();
  expect(renderer.webgl.dispose).toHaveBeenCalledOnce(); expect(renderer.webgl.forceContextLoss).toHaveBeenCalledOnce();
});

it('ready visible text does not wait for a retained offscreen glyph producer', async () => {
  renderer.setElements([note(), { ...note(), id: 'other', x: 2000 }]); renderer.render();
  const offscreen = latestText();
  renderer.setCamera({ x: 2000, y: 0, zoom: 1 }); renderer.render(); latestText().callbacks.shift()!();
  const result = await Promise.race([renderer.whenReady().then(() => 'ready'), new Promise<string>(resolve => setTimeout(() => resolve('blocked'), 20))]);
  expect(result).toBe('ready'); expect(renderer.stats().pendingTexts).toBe(1);
  offscreen.callbacks.shift()!(); await Promise.resolve();
  expect(renderer.stats().pendingTexts).toBe(0);
});

function shapeLabel(type: 'rect' | 'ellipse' = 'rect'): (ElementOf<'rect'> | ElementOf<'ellipse'>) & { props: ShapeTextProps } {
  return { ...stroke(0), id: 'shape-label', type, index: 'middle', x: 30, y: 40, w: 200, h: 140,
    props: { text: 'Shape label', align: 'center', autoSize: false, verticalAlign: 'middle' } };
}
async function readyShape(element = shapeLabel()): Promise<MockText> {
  renderer.setElements([element]); renderer.render();
  expect(renderer.stats().visibleTexts).toBe(1);
  const mesh = latestText(); mesh.callbacks.shift()!(); await renderer.whenReady(); return mesh;
}
describe('shape label projection', () => {
  it.each(['rect', 'ellipse'] as const)('uses the %s inset box, signed baseline and local clipping', async type => {
    const element = shapeLabel(type), mesh = await readyShape(element), block = textBlock(element)!, layout = textLayout(element);
    const baseline = block.insetY + (layout.verticalOffset ?? 0) + element.style.fontSize;
    expect(mesh.position.x).toBe(element.x + element.w / 2); expect(mesh.position.y).toBe(-element.y - baseline);
    expect(renderer.getTextObject(element.id)?.clipRect).toEqual([block.insetX - element.w / 2, baseline - (element.h - block.insetY), element.w / 2 - block.insetX, baseline - block.insetY]);
  });
  it('retains label handles for drag, rotation, color and opacity edits', async () => {
    const element = shapeLabel(), mesh = await readyShape(element);
    const next = { ...element, x: 80, y: 90, rotation: .5, style: { ...element.style, color: '#ff0000', opacity: .4 } };
    renderer.applyDiff([next]); renderer.render();
    const block = textBlock(next)!, p = rotatePoint({ x: next.x + next.w / 2, y: next.y + block.insetY + textLayout(next).verticalOffset! + next.style.fontSize }, { x: next.x + next.w / 2, y: next.y + next.h / 2 }, next.rotation);
    expect(renderer.getTextObject(element.id)).toBe(mesh); expect(mesh.dispose).not.toHaveBeenCalled();
    expect(mesh.position.x).toBeCloseTo(p.x); expect(mesh.position.y).toBeCloseTo(-p.y);
    expect(mesh.rotation.z).toBe(-.5); expect(renderer.stats().pendingTexts).toBe(0);
  });
  it.each(['height', 'vertical alignment', 'width', 'shape type'] as const)('keeps ready text until %s relayout succeeds', async field => {
    const element = shapeLabel(), old = await readyShape(element);
    const next = field === 'height' ? { ...element, h: 220 } : field === 'width' ? { ...element, w: 90 } : field === 'shape type' ? { ...element, type: 'ellipse' as const } : { ...element, props: { ...element.props, verticalAlign: 'bottom' as const } };
    renderer.applyDiff([next]); renderer.render(); const replacement = latestText();
    expect(replacement).not.toBe(old); expect(renderer.getTextObject(element.id)).toBe(old); expect(old.visible).toBe(true);
    expect(old.dispose).not.toHaveBeenCalled(); replacement.callbacks.shift()!(); await renderer.whenReady();
    expect(renderer.getTextObject(element.id)).toBe(replacement); expect(old.dispose).toHaveBeenCalledOnce();
    const block = textBlock(next)!, baseline = block.insetY + textLayout(next).verticalOffset! + next.style.fontSize;
    expect(replacement.position.y).toBe(-next.y - baseline);
  });
  it('retains signed overflowing offsets but creates no visible label for an empty inset box', async () => {
    const element = { ...shapeLabel(), h: 40, props: { ...shapeLabel().props, text: 'one\ntwo\nthree' } };
    const mesh = await readyShape(element), offset = textLayout(element).verticalOffset!;
    expect(offset).toBeLessThan(0); expect(renderer.getTextObject(element.id)?.clipRect).toHaveLength(4);
    renderer.applyDiff([{ ...element, h: 24 }]); renderer.render();
    expect(renderer.stats().visibleTexts).toBe(0); expect(mesh.parent).toBe(null);
    renderer.setElements([{ ...element, w: 24 }]); renderer.render();
    expect(renderer.stats().textInstances).toBe(0); expect(renderer.stats().pendingTexts).toBe(0);
  });
  it('clearing a label cancels both handles and late glyph completion cannot resurrect it', async () => {
    const element = shapeLabel(), old = await readyShape(element);
    renderer.applyDiff([{ ...element, props: { ...element.props, text: 'Changed label' } }]); renderer.render();
    const replacement = latestText(), finish = replacement.callbacks.shift()!;
    renderer.applyDiff([{ ...element, props: {} }]); renderer.render(); finish(); await renderer.whenReady();
    expect(old.dispose).toHaveBeenCalledOnce(); expect(replacement.dispose).toHaveBeenCalledOnce();
    expect(renderer.getTextObject(element.id)).toBeUndefined(); expect(renderer.stats().pendingTexts).toBe(0);
  });
});

it('equal-index shape label depths stay above their own fills and below the next fill', async () => {
  const labels = ['a', 'z'].map(id => ({ ...shapeLabel(), id, index: 'same', style: { ...DEFAULT_STYLE, opacity: .5 } }));
  renderer.setElements(labels); renderer.render();
  for (const mesh of textState.instances as MockText[]) mesh.callbacks.shift()!(); await renderer.whenReady();
  let id = 'b';
  for (let i = 0; i < 16; i++) {
    id += 'a'; renderer.applyDiff([{ ...shapeLabel('ellipse'), id, index: 'same', style: { ...DEFAULT_STYLE, opacity: .5 } }]); renderer.render(); latestText().callbacks.shift()!(); await renderer.whenReady();
    const fills = renderer.layers.shapes.children.filter(mesh => mesh instanceof THREE.InstancedMesh).sort((a, b) => a.renderOrder - b.renderOrder);
    const glyphs = renderer.layers.text.children.filter(mesh => mesh.visible).sort((a, b) => a.position.z - b.position.z);
    expect(glyphs).toHaveLength(fills.length);
    for (let j = 0; j < fills.length; j++) {
      expect(glyphs[j]!.position.z).toBeGreaterThan(fills[j]!.renderOrder - 1000);
      if (j + 1 < fills.length) expect(glyphs[j]!.position.z).toBeLessThan(fills[j + 1]!.renderOrder - 1000);
    }
  }
});

it('shape labels retain visible and editing pins within the offscreen text cache limit', async () => {
  renderer.dispose(); renderer = new ThreeRenderer({ canvas: { clientWidth: 1000, clientHeight: 800 } as HTMLCanvasElement, fontUrl: '/font.woff', offscreenTextCacheSize: 1 });
  const labels = Array.from({ length: 4 }, (_, n) => ({ ...shapeLabel(), id: `shape-${n}`, x: n * 2000 }));
  renderer.setElements(labels); renderer.render(); const pinned = latestText(); pinned.callbacks.shift()!(); await renderer.whenReady();
  renderer.setEditingText('shape-0');
  for (let n = 1; n < 4; n++) {
    renderer.setCamera({ x: n * 2000 + 100, y: 100, zoom: 1 }); renderer.render(); latestText().callbacks.shift()!(); await renderer.whenReady();
    expect(renderer.stats().textInstances).toBeLessThanOrEqual(3); expect(renderer.getTextObject('shape-0')).toBe(pinned);
  }
  expect(renderer.getTextObject('shape-1')).toBeUndefined(); expect(pinned.dispose).not.toHaveBeenCalled();
  renderer.setEditingText(null); renderer.render(); expect(renderer.stats().textInstances).toBe(2);
  renderer.setCamera({ x: 100, y: 100, zoom: 1 }); renderer.render(); await renderer.whenReady();
  expect(renderer.getTextObject('shape-0')).toBe(pinned); expect(pinned.visible).toBe(true);
});
it('shape readiness waits for exact visible or editing tasks while excluding offscreen work', async () => {
  const labels = [shapeLabel(), { ...shapeLabel('ellipse'), id: 'far-shape', x: 2000 }];
  renderer.setElements(labels); renderer.render(); const near = latestText();
  renderer.setCamera({ x: 2100, y: 100, zoom: 1 }); renderer.render(); const far = latestText(); far.callbacks.shift()!();
  await renderer.whenReady(); expect(renderer.stats().pendingTexts).toBe(1);
  renderer.setEditingText('shape-label'); let settled = false;
  const pending = renderer.whenReady().then(() => { settled = true; }); await Promise.resolve(); expect(settled).toBe(false);
  near.callbacks.shift()!(); await pending; expect(renderer.stats().pendingTexts).toBe(0);
});

it.each([['rect', false], ['rect', true], ['ellipse', false], ['ellipse', true]] as const)('projects remote editing badge and outline for %s with labeled=%s and removes stale frames', (type, labeled) => {
  const element: Element = { ...shapeLabel(type), props: labeled ? shapeLabel(type).props : {} };
  renderer.setElements([element]); renderer.render();
  const state = { clientId: 'shape-editor', name: 'Alice', color: '#4378ed', cursor: null, selection: [], editingTextId: element.id };
  renderer.setPresence([state]); renderer.render();
  const peer = renderer.layers.presence.getObjectByName('peer:shape-editor')!, badge = peer.children[2]!, frame = peer.children[1] as THREE.Mesh;
  expect(badge.visible).toBe(true); expect(frame.geometry.drawRange.count).toBe(24);
  expect(badge.children.at(-1)).toMatchObject({ text: 'Alice · editing', visible: false });
  for (const label of textState.instances as MockText[]) for (const callback of label.callbacks.splice(0)) callback();
  renderer.render(false);
  expect(badge.children.at(-1)?.visible).toBe(true); expect(renderer.stats()).toMatchObject({ presenceLabels: 2, pendingPresenceLabels: 0, presenceErrors: 0 });
  const position = badge.position.clone();
  renderer.applyDiff([{ ...element, x: element.x + 80 }]); renderer.render();
  expect(badge.position.x).toBeCloseTo(position.x + 80); expect(badge.visible).toBe(true); expect(frame.geometry.drawRange.count).toBe(24);
  renderer.setPresence([{ ...state, editingTextId: null }]); renderer.render();
  expect(badge.visible).toBe(false); expect(frame.geometry.drawRange.count).toBe(0);
  renderer.setPresence([state]); renderer.render(); expect(badge.visible).toBe(true);
  renderer.applyDiff([], [element.id]); renderer.render();
  expect(badge.visible).toBe(false); expect(frame.geometry.drawRange.count).toBe(0);
});
