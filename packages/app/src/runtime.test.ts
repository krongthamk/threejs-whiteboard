import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoardDocument } from '@whiteboard/model';
import { EditorRuntime } from './runtime';

const renderer = vi.hoisted(() => ({
  setElements: vi.fn(), setCamera: vi.fn(), applyDiff: vi.fn(), resize: vi.fn(),
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
