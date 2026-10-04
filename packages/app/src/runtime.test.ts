import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoardDocument } from '@whiteboard/model';
import { EditorRuntime } from './runtime';

const renderer = vi.hoisted(() => ({
  setPixelRatio: vi.fn(), setElements: vi.fn(), setCamera: vi.fn(), applyDiff: vi.fn(), resize: vi.fn(),
  render: vi.fn(), dispose: vi.fn(), getMaxImageDimension: vi.fn(() => 4096),
}));
vi.mock('@whiteboard/renderer', () => ({ createRenderer: () => renderer }));
vi.mock('./controller', () => ({ EditorController: class { destroy() {} } }));
vi.mock('./text-editor', () => ({ BoardTextEditor: class { cancel = vi.fn(); destroy() {} } }));
vi.mock('./assets', () => ({ BoardAssets: class { destroy() {} } }));
vi.mock('./export', () => ({ BoardExporter: class { destroy() {} } }));

let runtime: EditorRuntime | undefined;
const canvas = { getBoundingClientRect: () => ({ width: 800, height: 600 }) } as HTMLCanvasElement;
const poison = (board: BoardDocument) => {
  const healthy = board.read('healthy')!;
  board.doc.transact(() => board.doc.getArray('element-properties:poison-test').push([
    { key: JSON.stringify(['poisoned', '$base']), val: { stamp: { clock: 1, actor: 'poison-test' }, value: { generation: 'bad-generation', element: { ...healthy, id: 'poisoned', x: 'nope' } } } },
    { key: 'not-json', val: { stamp: { clock: 2, actor: 'poison-test' }, value: null } },
    null,
  ]), 'remote-poison-fixture');
};

beforeEach(() => {
  vi.stubGlobal('devicePixelRatio', 1);
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
});
afterEach(() => { runtime?.destroy(); runtime = undefined; vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('runtime quarantine and recovery', () => {
  it('reports initial poisoned records and keeps valid changes projected', () => {
    const board = new BoardDocument(); board.create('rect', { id: 'healthy' }); poison(board);
    const onDiagnosticsChange = vi.fn(), onError = vi.fn();
    runtime = new EditorRuntime({ canvas, board, onDiagnosticsChange, onError, onChange: vi.fn(), onEditText: vi.fn() });
    expect(onDiagnosticsChange).toHaveBeenCalledWith({ invalidIds: new Set(['poisoned']), malformedRecords: 2, schemaVersion: 2 });
    expect(renderer.setElements.mock.calls[0]![0].map((element: { id: string }) => element.id)).toEqual(['healthy']);
    expect(runtime.elementCount).toBe(1);
    board.update('healthy', { x: 9 });
    expect(renderer.applyDiff.mock.calls.at(-1)![0]).toEqual([expect.objectContaining({ id: 'healthy', x: 9 })]);
    expect(onError).not.toHaveBeenCalled();
  });

  it('removes newly invalid projections and selection, including diagnostics-only changes', () => {
    const board = new BoardDocument(); board.create('rect', { id: 'healthy' });
    const onDiagnosticsChange = vi.fn(), onError = vi.fn();
    runtime = new EditorRuntime({ canvas, board, onDiagnosticsChange, onError, onChange: vi.fn(), onEditText: vi.fn() });
    runtime.session.setState({ selectedIds: ['healthy'] });
    board.doc.getArray('element-properties:poison-test').push([
      { key: JSON.stringify(['healthy', '$base']), val: { stamp: { clock: 2, actor: 'poison-test' }, value: { generation: 'bad-generation', element: { ...board.read('healthy')!, x: 'nope' } } } },
    ]);
    expect(runtime.elementCount).toBe(0);
    expect(runtime.session.getState().selectedIds).toEqual([]);
    expect(renderer.applyDiff).toHaveBeenLastCalledWith([], ['healthy']);
    expect(onDiagnosticsChange.mock.calls.at(-1)![0]).toMatchObject({ invalidIds: new Set(['healthy']), malformedRecords: 0 });
    board.doc.getArray('element-properties:poison-test').push([null]);
    expect(onDiagnosticsChange.mock.calls.at(-1)![0]).toMatchObject({ invalidIds: new Set(['healthy']), malformedRecords: 1 });
    expect(onError).not.toHaveBeenCalled();
  });

  it('reports unsupported initial and changed metadata and blocks editing until repaired', () => {
    const board = new BoardDocument(); board.create('rect', { id: 'healthy' }); board.meta.set('schemaVersion', 99);
    const onDiagnosticsChange = vi.fn();
    runtime = new EditorRuntime({ canvas, board, onDiagnosticsChange, onError: vi.fn(), onChange: vi.fn(), onEditText: vi.fn() });
    expect(runtime.readOnly).toBe(true);
    expect(onDiagnosticsChange.mock.calls[0]![0].schemaVersion).toBe(99);
    runtime.applyStyle({ fill: '#123456' });
    expect(board.read('healthy')!.style.fill).not.toBe('#123456');
    board.meta.set('schemaVersion', 2);
    expect(runtime.readOnly).toBe(false);
    expect(onDiagnosticsChange.mock.calls.at(-1)![0].schemaVersion).toBe(2);
    board.meta.set('schemaVersion', 99);
    expect(runtime.textEditor.cancel).toHaveBeenCalled();
    runtime.readOnly = true; board.meta.set('schemaVersion', 2);
    expect(runtime.readOnly).toBe(true);
  });

  it('contains asynchronous projection failures and exposes the error without escaping Yjs', () => {
    const board = new BoardDocument(), onError = vi.fn(), onDiagnosticsChange = vi.fn();
    runtime = new EditorRuntime({ canvas, board, onError, onDiagnosticsChange, onChange: vi.fn(), onEditText: vi.fn() });
    renderer.applyDiff.mockImplementationOnce(() => { throw new Error('Projection failed'); });
    expect(() => board.create('rect', { id: 'healthy' })).not.toThrow();
    expect(onError).toHaveBeenCalledWith('Projection failed');
    expect(onDiagnosticsChange).toHaveBeenCalledTimes(2);
    board.update('healthy', { x: 9 });
    expect(renderer.applyDiff.mock.calls.at(-1)![0]).toEqual([expect.objectContaining({ id: 'healthy', x: 9 })]);
  });
});

  it('does not re-read selected IDs for unrelated changes or metadata-only events', () => {
    const board = new BoardDocument();
    for (let i = 0; i < 100; i++) board.create('rect', { id: `selected-${i}` });
    board.create('rect', { id: 'unrelated' });
    runtime = new EditorRuntime({ canvas, board, onError: vi.fn(), onChange: vi.fn(), onEditText: vi.fn() });
    runtime.session.setState({ selectedIds: Array.from({ length: 100 }, (_, i) => `selected-${i}`) });
    const read = vi.spyOn(board, 'read');
    board.update('unrelated', { x: 10 });
    expect(read.mock.calls.filter(([id]) => id.startsWith('selected-'))).toEqual([]);
    read.mockClear(); board.meta.set('title', 'Renamed'); expect(read).not.toHaveBeenCalled();
    board.delete('selected-50'); expect(runtime.session.getState().selectedIds).not.toContain('selected-50');
  });


it('refreshes the drawing buffer on a DPR change and removes its rearmed observer on destroy', () => {
  const queries: { callback?: () => void; addEventListener: ReturnType<typeof vi.fn>; removeEventListener: ReturnType<typeof vi.fn> }[] = [];
  const matchMedia = vi.fn(() => {
    const query = { callback: undefined as (() => void) | undefined, addEventListener: vi.fn((_: string, callback: () => void) => { query.callback = callback; }), removeEventListener: vi.fn() };
    queries.push(query); return query;
  });
  vi.stubGlobal('matchMedia', matchMedia);
  runtime = new EditorRuntime({ canvas, onError: vi.fn(), onChange: vi.fn(), onEditText: vi.fn() });
  vi.stubGlobal('devicePixelRatio', 3);
  queries[0]?.callback?.();
  expect(renderer.setPixelRatio).toHaveBeenLastCalledWith(2);
  expect(renderer.resize).toHaveBeenLastCalledWith(800, 600);
  expect(matchMedia).toHaveBeenLastCalledWith('(resolution: 3dppx)');
  expect(queries[0]?.removeEventListener).toHaveBeenCalledWith('change', queries[0]?.callback);
  runtime.destroy();
  expect(queries[1]?.removeEventListener).toHaveBeenCalledWith('change', queries[1]?.callback);
});


it('observes a silent DPR change in the existing RAF and leaves unchanged frames alone', () => {
  let nextFrame!: FrameRequestCallback;
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => { nextFrame = callback; return 1; }));
  const remove = vi.fn(), add = vi.fn();
  vi.stubGlobal('matchMedia', vi.fn(() => ({ addEventListener: add, removeEventListener: remove })));
  runtime = new EditorRuntime({ canvas, onError: vi.fn(), onChange: vi.fn(), onEditText: vi.fn() });
  renderer.resize.mockClear(); renderer.setPixelRatio.mockClear();
  for (let i = 0; i < 10; i++) nextFrame(i);
  expect(renderer.resize).not.toHaveBeenCalled(); expect(renderer.setPixelRatio).not.toHaveBeenCalled(); expect(add).toHaveBeenCalledTimes(1);
  vi.stubGlobal('devicePixelRatio', 1.5); nextFrame(11);
  expect(renderer.setPixelRatio).toHaveBeenLastCalledWith(1.5); expect(renderer.resize).toHaveBeenCalledOnce();
  expect(remove).toHaveBeenCalledOnce(); expect(add).toHaveBeenCalledTimes(2);
  for (let i = 12; i < 20; i++) nextFrame(i);
  expect(renderer.setPixelRatio).toHaveBeenCalledOnce(); expect(renderer.resize).toHaveBeenCalledOnce(); expect(add).toHaveBeenCalledTimes(2);
});
