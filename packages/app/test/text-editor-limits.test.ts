import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { BoardDocument } from '@whiteboard/model';
import type { ThreeRenderer } from '@whiteboard/renderer';
import { BoardTextEditor } from '../src/text-editor';
import { createSession } from '../src/session';

class NativeInput {
  innerText = ''; style = {}; handlers = new Map<string, EventListener>();
  get textContent(): string { return this.innerText; }
  set textContent(value: string) { this.innerText = value; }
  setAttribute() {} append() {} remove() {} focus() {} contains(node: unknown) { return node === this; }
  addEventListener(type: string, listener: EventListener) { this.handlers.set(type, listener); }
  fire(type: string, event: object = {}) { this.handlers.get(type)?.(event as Event); }
}
function setup(originalText = 'saved') {
  vi.useFakeTimers();
  const nodes: NativeInput[] = [], selection = { anchorNode: null as NativeInput | null, focusNode: null as NativeInput | null, text: '',
    toString() { return this.text; }, removeAllRanges() {}, addRange() {} };
  vi.stubGlobal('document', { createElement() { const node = new NativeInput(); nodes.push(node); return node; }, createRange: () => ({ selectNodeContents() {}, collapse() {} }) });
  vi.stubGlobal('window', { getSelection: () => selection });
  let resize = () => {};
  vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resize = callback; } observe() {} disconnect() {} });
  const bounds = () => ({ left: 0, top: 0, width: 800, height: 600 });
  const canvas = { parentElement: { append() {}, getBoundingClientRect: bounds }, getBoundingClientRect: bounds, focus() {} } as unknown as HTMLCanvasElement;
  const board = new BoardDocument(); board.create('text', { id: 'text', props: { text: originalText, autoSize: false, align: 'left' } }); board.undoManager.clear();
  const session = createSession('editor-limit'), onError = vi.fn(); let readOnly = false;
  const editor = new BoardTextEditor({ board, session, canvas, renderer: { setEditingText() {} } as unknown as ThreeRenderer, isReadOnly: () => readOnly, onError });
  editor.open('text'); const input = nodes[1]!; selection.anchorNode = input; selection.focusNode = input;
  return { board, session, editor, input, onError, selection, resize: () => resize(), setReadOnly: () => { readOnly = true; },
    destroy() { editor.destroy(); session.dispose(); board.destroy(); } };
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('native draft limits and interruptions', () => {
  it('rejects an oversized commit visibly without writes or history', () => {
    const f = setup(), before = Y.encodeStateAsUpdate(f.board.doc);
    f.input.innerText = 'x'.repeat(50_001); f.editor.commit();
    expect(f.onError).toHaveBeenCalledWith(expect.stringMatching(/50,000/));
    expect(f.board.read('text')!.props).toMatchObject({ text: 'saved' });
    expect(Y.encodeStateAsUpdate(f.board.doc)).toEqual(before); expect(f.board.undoManager.undoStack).toHaveLength(0); f.destroy();
  });

  it('blocks over-limit typing and paste but allows a selected replacement at the limit', () => {
    const f = setup('x'.repeat(50_000)), typing = vi.fn(), paste = vi.fn();
    f.input.fire('beforeinput', { inputType: 'insertText', data: '😀', isComposing: false, preventDefault: typing });
    f.input.fire('paste', { clipboardData: { getData: () => 'y' }, preventDefault: paste });
    expect(typing).toHaveBeenCalled(); expect(paste).toHaveBeenCalled(); expect(f.input.innerText).toHaveLength(50_000);
    f.selection.text = 'xx'; const replacement = vi.fn();
    f.input.fire('beforeinput', { inputType: 'insertText', data: '😀', isComposing: false, preventDefault: replacement });
    expect(replacement).not.toHaveBeenCalled(); f.destroy();
  });

  it('debounces only long draft input, keeps camera/resize/peer geometry immediate and cancels stale timers', () => {
    const f = setup(), position = vi.spyOn(f.editor as unknown as { position(): void }, 'position');
    f.input.innerText = 'x'.repeat(5_000); f.input.fire('input'); expect(position).toHaveBeenCalledTimes(1); position.mockClear();
    for (let i = 1; i <= 4; i++) { f.input.innerText = 'x'.repeat(5_000 + i); f.input.fire('input'); }
    expect(position).not.toHaveBeenCalled(); vi.advanceTimersByTime(150); expect(position).toHaveBeenCalledTimes(1); position.mockClear();
    f.input.fire('input'); f.session.setState({ camera: { x: 10, y: 20, zoom: 2 } }); expect(position).toHaveBeenCalledTimes(1);
    f.resize(); expect(position).toHaveBeenCalledTimes(2); f.board.update('text', { x: 10 }); expect(position).toHaveBeenCalledTimes(3);
    position.mockClear(); f.input.fire('input'); f.editor.commit(); vi.advanceTimersByTime(150);
    expect(f.editor.editingId).toBeNull(); expect(position).not.toHaveBeenCalled(); expect(f.board.read('text')!.props).toMatchObject({ text: 'x'.repeat(5_004) }); f.destroy();
  });

  it('waits for composition end after blur and rejects the whole oversized insertion without truncating accepted text', () => {
    const f = setup('x'.repeat(49_999));
    f.input.fire('compositionstart'); f.input.innerText += '日本語'; f.input.fire('input'); f.input.fire('blur');
    expect(f.editor.editingId).toBe('text'); expect(f.board.undoManager.undoStack).toHaveLength(0);
    f.input.fire('compositionend'); expect(f.editor.editingId).toBeNull();
    expect(f.onError).toHaveBeenCalledWith(expect.stringMatching(/50,000/));
    expect(f.board.read('text')!.props).toMatchObject({ text: 'x'.repeat(49_999) }); expect(f.board.undoManager.undoStack).toHaveLength(0); f.destroy();
  });

  it('commits Escape once and undo restores the saved text', () => {
    const f = setup(); f.input.innerText = 'new draft';
    f.input.fire('keydown', { key: 'Escape', stopPropagation() {}, preventDefault() {} });
    expect(f.board.read('text')!.props).toMatchObject({ text: 'new draft' }); expect(f.board.undoManager.undoStack).toHaveLength(1);
    f.board.undoManager.undo(); expect(f.board.read('text')!.props).toMatchObject({ text: 'saved' }); expect(f.onError).not.toHaveBeenCalled(); f.destroy();
  });

  it.each(['deleted', 'read-only'] as const)('reports changed drafts on %s interruption without resurrection or unauthorized writes', reason => {
    const f = setup(); f.input.innerText = 'unsaved draft';
    if (reason === 'deleted') f.board.doc.transact(() => f.board.delete('text'), 'peer');
    else { f.setReadOnly(); f.editor.cancel(); }
    expect(f.onError).toHaveBeenCalledWith(expect.stringMatching(/not saved/)); expect(f.editor.editingId).toBeNull();
    expect(f.board.undoManager.undoStack).toHaveLength(0);
    if (reason === 'deleted') expect(f.board.read('text')).toBeUndefined(); else expect(f.board.read('text')!.props).toMatchObject({ text: 'saved' }); f.destroy();
  });

  it('does not warn about an unchanged draft when a peer removes its element', () => {
    const f = setup(); f.board.doc.transact(() => f.board.delete('text'), 'peer');
    expect(f.onError).not.toHaveBeenCalled(); expect(f.editor.editingId).toBeNull(); f.destroy();
  });

  it('does not claim already-saved peer text was lost on read-only interruption', () => {
    const f = setup(); f.input.innerText = 'matching peer text';
    f.board.doc.transact(() => f.board.update('text', { props: { text: 'matching peer text', autoSize: false, align: 'left' } }), 'peer');
    const before = Y.encodeStateAsUpdate(f.board.doc); f.setReadOnly(); f.editor.cancel();
    expect(f.onError).not.toHaveBeenCalled(); expect(Y.encodeStateAsUpdate(f.board.doc)).toEqual(before);
    expect(f.board.undoManager.undoStack).toHaveLength(0); f.destroy();
  });

  it('rejects uncancellable over-limit input as a whole and preserves the preceding complete surrogate pair', () => {
    const f = setup(); f.input.innerText = 'x'.repeat(49_998) + '😀'; f.input.fire('input');
    f.input.innerText += 'x'; f.input.fire('input');
    expect(f.input.innerText).toBe('x'.repeat(49_998) + '😀');
    expect(f.onError).toHaveBeenCalledWith(expect.stringMatching(/50,000/)); f.editor.commit();
    expect(f.board.read('text')!.props).toMatchObject({ text: 'x'.repeat(49_998) + '😀' });
    expect(f.board.undoManager.undoStack).toHaveLength(1); f.destroy();
  });
});
