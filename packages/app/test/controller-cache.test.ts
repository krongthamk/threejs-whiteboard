import { afterEach, expect, it, vi } from 'vitest';
import { BoardDocument, bindToElement } from '@whiteboard/model';
import { EditorController } from '../src/controller';
import { createSession } from '../src/session';
import { selectionFrame } from '../src/hit-test';
import type { ThreeRenderer } from '@whiteboard/renderer';

vi.mock('@whiteboard/renderer', () => ({ selectionHandles: () => [] }));
vi.mock('../src/hit-test', async importOriginal => {
  const original = await importOriginal<typeof import('../src/hit-test')>();
  return { ...original, selectionFrame: vi.fn(original.selectionFrame) };
});
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

function setup(board: BoardDocument) {
  const events = new Map<string, (event: unknown) => void>();
  const canvasEvents = new Map<string, (event: unknown) => void>();
  vi.stubGlobal('window', { addEventListener: (name: string, fn: (event: unknown) => void) => events.set(name, fn), removeEventListener() {} });
  vi.stubGlobal('HTMLElement', class {});
  vi.stubGlobal('Element', class {});
  const captured = new Set<number>();
  const canvas = { style: { touchAction: '' }, addEventListener: (name: string, fn: (event: unknown) => void) => canvasEvents.set(name, fn), removeEventListener() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }), focus() {},
    setPointerCapture: (id: number) => captured.add(id), hasPointerCapture: (id: number) => captured.has(id), releasePointerCapture: (id: number) => captured.delete(id) } as unknown as HTMLCanvasElement;
  const session = createSession('cache-unit');
  const renderer = { setSelection: vi.fn(), applyDiff: vi.fn(), setLiveStroke: vi.fn() };
  const controller = new EditorController({ canvas, board, renderer: renderer as unknown as ThreeRenderer, session, onEditText() {}, isReadOnly: () => false });
  const pointer = { clientX: 420, clientY: 320, pointerId: 1, button: 0, pointerType: 'mouse', preventDefault() {} };
  return { controller, session, renderer, events, canvasEvents, pointer, captured, destroy: () => { controller.destroy(); session.dispose(); board.destroy(); } };
}

it('create, select-all and fit use cached projections rather than readAll', () => {
  const board = new BoardDocument(); board.create('rect', { id: 'a' }); const fixture = setup(board);
  const readAll = vi.spyOn(board, 'readAll');
  fixture.events.get('keydown')!({ key: 'a', code: 'KeyA', ctrlKey: true, preventDefault() {} });
  expect(fixture.session.getState().selectedIds).toEqual(['a']);
  fixture.controller.zoomToFit();
  fixture.session.setState({ tool: 'rect' }); fixture.canvasEvents.get('pointerdown')!(fixture.pointer);
  expect(readAll).not.toHaveBeenCalled(); fixture.destroy();
});

it('reuses selection frames on hover, camera change and unrelated updates but invalidates membership and selected changes', () => {
  const board = new BoardDocument(); for (const id of ['a', 'b', 'unrelated']) board.create('rect', { id });
  const fixture = setup(board); fixture.session.setState({ selectedIds: ['a', 'b'] });
  const reads = vi.spyOn(board, 'read'); vi.mocked(selectionFrame).mockClear();
  fixture.canvasEvents.get('pointermove')!(fixture.pointer); fixture.canvasEvents.get('pointermove')!(fixture.pointer);
  fixture.session.setState({ camera: { x: 20, y: 30, zoom: 2 } });
  expect(reads).not.toHaveBeenCalled(); expect(selectionFrame).not.toHaveBeenCalled();
  board.update('unrelated', { x: 100 }); expect(selectionFrame).not.toHaveBeenCalled();
  board.update('a', { x: 25 }); expect(selectionFrame).toHaveBeenCalled();
  vi.mocked(selectionFrame).mockClear(); fixture.session.setState({ selectedIds: ['b'] }); expect(selectionFrame).toHaveBeenCalled();
  fixture.destroy();
});

it('invalidates the frame when a selected connector target changes, including preview movement', () => {
  const board = new BoardDocument(); const target = board.create('rect', { id: 'target' });
  board.create('connector', { id: 'connector', props: { start: bindToElement(target, .5, .5), end: { x: 500, y: 200 }, kind: 'straight' } });
  const fixture = setup(board); fixture.session.setState({ selectedIds: ['connector'] });
  const first = fixture.renderer.setSelection.mock.calls.at(-1)![0].frame;
  vi.mocked(selectionFrame).mockClear(); board.update('target', { x: 200 });
  expect(selectionFrame).toHaveBeenCalled(); expect(fixture.renderer.setSelection.mock.calls.at(-1)![0].frame).not.toEqual(first);
  fixture.session.setState({ selectedIds: ['target'] }); fixture.canvasEvents.get('pointerdown')!({ ...fixture.pointer, clientX: 700, clientY: 350 });
  vi.mocked(selectionFrame).mockClear(); fixture.canvasEvents.get('pointermove')!({ ...fixture.pointer, clientX: 730, clientY: 350 });
  expect(selectionFrame).toHaveBeenCalled(); fixture.destroy();
});

it('reanchors remaining touch fingers without a camera jump or an accidental edit', () => {
  const board = new BoardDocument(), fixture = setup(board);
  fixture.session.setState({ tool: 'rect' });
  const touch = (type: string, id: number, x: number) => fixture.canvasEvents.get(type)!({ ...fixture.pointer, type, pointerType: 'touch', pointerId: id, clientX: x, clientY: 300 });
  touch('pointerdown', 1, 400); touch('pointermove', 1, 420); touch('pointerdown', 2, 600);
  touch('pointermove', 1, 375); touch('pointermove', 2, 645);
  const before = fixture.session.getState().camera; expect(before.zoom).toBeCloseTo(1.5);
  touch('pointerdown', 3, 800); expect(fixture.session.getState().camera).toEqual(before);
  touch('pointerup', 1, 375); expect(fixture.session.getState().camera).toEqual(before);
  expect(fixture.captured).toEqual(new Set([2, 3]));
  touch('pointermove', 2, 600); touch('pointermove', 3, 845);
  expect(fixture.session.getState().camera.zoom).toBeCloseTo(1.5 * 245 / 155);
  touch('pointerup', 2, 600);
  const last = fixture.session.getState().camera;
  touch('pointermove', 3, 900); touch('pointerup', 3, 900);
  expect(fixture.session.getState().camera).toEqual(last);
  expect(board.readAll()).toEqual([]); expect(board.undoManager.undoStack).toHaveLength(0);
  expect(fixture.captured.size).toBe(0);
  touch('pointerdown', 4, 400); touch('pointerdown', 5, 600);
  fixture.events.get('blur')!({}); expect(fixture.captured.size).toBe(0);
  expect(board.readAll()).toEqual([]); fixture.destroy();
});
