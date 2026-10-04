import { afterEach, expect, it, vi } from 'vitest';
import { BoardDocument } from '@whiteboard/model';
import { EditorRuntime } from '../src/runtime';

const renderer = vi.hoisted(() => ({ setElements: vi.fn(), applyDiff: vi.fn(), setCamera() {}, resize() {}, render() {}, dispose() {} }));
vi.mock('@whiteboard/renderer', () => ({ createRenderer: () => renderer }));
vi.mock('../src/controller', () => ({ EditorController: class { destroy() {} } }));
vi.mock('../src/text-editor', () => ({ BoardTextEditor: class { cancel() {} destroy() {} } }));
vi.mock('../src/assets', () => ({ BoardAssets: class { destroy() {} } }));
vi.mock('../src/export', () => ({ BoardExporter: class { destroy() {} } }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

it('warns once per missing-codepoint set on initial and changed text without blocking rendering or edits', () => {
  vi.stubGlobal('devicePixelRatio', 1); vi.stubGlobal('requestAnimationFrame', () => 1); vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const board = new BoardDocument(); board.create('text', { id: 'text', props: { text: 'กก', align: 'left', autoSize: true } });
  const canvas = { getBoundingClientRect: () => ({ width: 800, height: 600 }) } as HTMLCanvasElement;
  const onError = vi.fn(), runtime = new EditorRuntime({ board, canvas, onError, onChange() {}, onEditText() {} });
  expect(onError).toHaveBeenCalledTimes(1); expect(onError).toHaveBeenLastCalledWith(expect.stringMatching(/U\+0E01/));
  expect(renderer.setElements).toHaveBeenCalled();
  board.update('text', { props: { text: 'กกก', align: 'left', autoSize: true } }); board.updateStyle(['text'], { color: '#123456' });
  runtime.session.setState({ camera: { x: 10, y: 20, zoom: 2 } }); expect(onError).toHaveBeenCalledTimes(1);
  board.create('sticky', { id: 'sticky', props: { text: '🦄🦄', align: 'left', autoSize: false } });
  expect(onError).toHaveBeenCalledTimes(2); expect(onError).toHaveBeenLastCalledWith(expect.stringMatching(/U\+1F984/));
  board.update('text', { props: { text: 'Hello 日本語\t\n', align: 'left', autoSize: true } });
  expect(onError).toHaveBeenCalledTimes(2); expect(board.read('sticky')!.props).toMatchObject({ text: '🦄🦄' });
  expect(renderer.applyDiff).toHaveBeenCalled(); runtime.destroy();
});
