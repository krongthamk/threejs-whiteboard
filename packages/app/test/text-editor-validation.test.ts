import { afterEach, expect, it, vi } from 'vitest';
import { BoardDocument } from '@whiteboard/model';
import { BoardTextEditor } from '../src/text-editor';
import { createSession } from '../src/session';
import type { ThreeRenderer } from '@whiteboard/renderer';

afterEach(() => vi.unstubAllGlobals());
it('rejects malformed UTF-16 drafts visibly without committing or escaping the native editor handler', () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const board = new BoardDocument(); board.create('text', { id: 'text', props: { text: 'saved😀', autoSize: true, align: 'left' } });
  const session = createSession('editor-validation'), onError = vi.fn();
  const editor = new BoardTextEditor({ board, session, canvas: {} as HTMLCanvasElement, renderer: { setEditingText() {} } as unknown as ThreeRenderer, isReadOnly: () => false, onError });
  Reflect.set(editor, 'active', { id: 'text', originalText: 'saved😀', input: { innerText: 'x\ud83dy' }, wrapper: { remove: vi.fn() }, composing: false });
  const before = board.undoManager.undoStack.length;
  expect(() => editor.commit()).not.toThrow(); expect(onError).toHaveBeenCalledWith(expect.stringMatching(/incomplete or invalid character/));
  expect(board.read('text')!.props).toMatchObject({ text: 'saved😀' }); expect(board.undoManager.undoStack).toHaveLength(before);
  expect(editor.editingId).toBeNull(); editor.destroy(); session.dispose(); board.destroy();
});
