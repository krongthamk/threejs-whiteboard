import { BoardDocument, deriveElementGeometry, isWellFormedString, MAX_TEXT_LENGTH, TEXT_LINE_HEIGHT, resolvedFontFamily, textBlock, textLayout, type Element } from '@whiteboard/model';
import type { ThreeRenderer } from '@whiteboard/renderer';
import type { SessionStore } from './session';

type TextElement = Extract<Element, { type: 'text' | 'sticky' | 'rect' | 'ellipse' }>;
const editable = (element: Element | undefined): element is TextElement => !!element && ['text', 'sticky', 'rect', 'ellipse'].includes(element.type);
const sourceText = (element: TextElement): string => textBlock(element)?.text ?? '';
const LONG_DRAFT_LENGTH = 5_000;
const DRAFT_POSITION_DELAY = 100;
const TEXT_LIMIT_NOTICE = 'Text cannot exceed 50,000 characters. The extra text was not added.';
interface TextEditorOptions {
  canvas: HTMLCanvasElement;
  board: BoardDocument;
  renderer: ThreeRenderer;
  session: SessionStore;
  isReadOnly(): boolean;
  onEditingChange?(id: string | null): void;
  onError(message: string): void;
}

/** Native editing state stays local until one final, coherent props write. */
export class BoardTextEditor {
  private active: { id: string; originalText: string; acceptedText: string; wrapper: HTMLDivElement; input: HTMLDivElement; composing: boolean; blurPending: boolean } | null = null;
  private unsubscribe: () => void;
  private unsubscribeSession: () => void;
  private resizeObserver: ResizeObserver;
  private positionTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private options: TextEditorOptions) {
    this.unsubscribeSession = options.session.subscribe(() => this.position());
    this.unsubscribe = options.board.subscribe(({ ids }) => {
      if (!this.active || !ids.has(this.active.id)) return;
      const current = options.board.read(this.active.id);
      if (!editable(current)) this.finish(false);
      else this.position();
    });
    this.resizeObserver = new ResizeObserver(() => this.position());
    this.resizeObserver.observe(options.canvas);
  }

  open(id: string): void {
    if (this.options.isReadOnly()) return;
    if (this.active?.id === id) { this.active.input.focus(); return; }
    if (this.active?.composing) return;
    this.finish(true);
    const element = this.options.board.read(id);
    if (!editable(element)) return;
    const text = sourceText(element), shape = element.type === 'rect' || element.type === 'ellipse';
    const wrapper = document.createElement('div'), input = document.createElement('div');
    wrapper.className = 'text-editor-anchor'; input.className = 'native-text-editor';
    input.contentEditable = 'plaintext-only'; input.role = 'textbox'; input.spellcheck = true;
    input.setAttribute('aria-label', 'Edit text'); input.setAttribute('aria-multiline', 'true');
    if (shape) { input.classList.add('shape-text-editor'); input.dataset.placeholder = 'Type a label'; }
    // Chromium keeps a final caret line as an extra LF (or a terminal BR).
    // Start with the same representation so normalization also preserves saved trailing lines.
    input.textContent = text.endsWith('\n') ? `${text}\n` : text;
    wrapper.append(input); this.options.canvas.parentElement!.append(wrapper);
    this.active = { id, originalText: text, acceptedText: text, wrapper, input, composing: false, blurPending: false };
    this.options.renderer.setEditingText(id);
    this.options.onEditingChange?.(id);
    input.addEventListener('compositionstart', () => {
      if (this.active?.input === input) { this.active.composing = true; if (shape) input.dataset.empty = 'false'; }
    });
    input.addEventListener('compositionend', () => {
      if (this.active?.input !== input) return;
      this.active.composing = false;
      this.acceptDraft();
      if (this.active.blurPending) this.finish(true); else this.schedulePosition();
    });
    input.addEventListener('blur', () => {
      if (this.active?.input !== input) return;
      if (this.active.composing) this.active.blurPending = true;
      else this.finish(true);
    });
    input.addEventListener('beforeinput', event => {
      if (this.active?.input !== input || event.isComposing || this.active.composing || !event.inputType.startsWith('insert')) return;
      const text = event.inputType === 'insertParagraph' || event.inputType === 'insertLineBreak' ? '\n' : event.data ?? event.dataTransfer?.getData('text/plain');
      if (text !== undefined && text !== null && !this.insertionFits(text)) { event.preventDefault(); this.options.onError(TEXT_LIMIT_NOTICE); }
    });
    input.addEventListener('paste', event => {
      if (this.active?.input !== input) return;
      const text = event.clipboardData?.getData('text/plain');
      if (text !== undefined && !this.insertionFits(text)) { event.preventDefault(); this.options.onError(TEXT_LIMIT_NOTICE); }
    });
    input.addEventListener('input', () => {
      if (this.active?.input !== input) return;
      if (!this.active.composing && !this.acceptDraft()) return;
      this.schedulePosition();
    });
    input.addEventListener('keydown', event => {
      event.stopPropagation();
      if (event.isComposing || this.active?.composing) return;
      if (event.key === 'Escape') { event.preventDefault(); this.finish(true); this.options.canvas.focus(); }
      else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); this.finish(true); this.options.canvas.focus(); }
    });
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'dblclick']) input.addEventListener(type, event => event.stopPropagation());
    this.position(); input.focus();
    const range = document.createRange(); range.selectNodeContents(input);
    const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
    if (shape) input.scrollTop = input.scrollHeight;
  }

  get editingId(): string | null { return this.active?.id ?? null; }

  private draft(): string {
    const text = this.active?.input.innerText.replace(/\r\n?/g, '\n') ?? '';
    // Remove one browser caret placeholder, never trim intentional whitespace or blank lines.
    return text.endsWith('\n') ? text.slice(0, -1) : text;
  }

  private insertionFits(text: string): boolean {
    if (!this.active) return true;
    const length = this.draft().length, selection = window.getSelection();
    const selected = selection && this.active.input.contains(selection.anchorNode) && this.active.input.contains(selection.focusNode)
      ? Math.min(length, selection.toString().replace(/\r\n?/g, '\n').length) : 0;
    return length - selected + text.replace(/\r\n?/g, '\n').length <= MAX_TEXT_LENGTH;
  }

  /** Reject the complete insertion, preserving the last accepted draft without truncation. */
  private acceptDraft(): boolean {
    if (!this.active) return false;
    const text = this.draft();
    if (text.length <= MAX_TEXT_LENGTH) {
      if (isWellFormedString(text)) this.active.acceptedText = text;
      return true;
    }
    const restored = this.active.acceptedText;
    this.active.input.textContent = restored.endsWith('\n') ? `${restored}\n` : restored;
    const range = document.createRange(); range.selectNodeContents(this.active.input); range.collapse(false);
    const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
    this.options.onError(TEXT_LIMIT_NOTICE); this.position(); return false;
  }

  private clearPositionTimer(): void { clearTimeout(this.positionTimer); this.positionTimer = undefined; }
  private schedulePosition(): void {
    this.clearPositionTimer();
    if (!this.active) return;
    if (this.draft().length <= LONG_DRAFT_LENGTH) { this.position(); return; }
    const active = this.active;
    this.positionTimer = setTimeout(() => { this.positionTimer = undefined; if (this.active === active) this.position(); }, DRAFT_POSITION_DELAY);
  }

  private position(): void {
    this.clearPositionTimer();
    if (!this.active) return;
    const source = this.options.board.read(this.active.id);
    if (!editable(source)) return;
    const text = this.draft();
    const draft = text.length > MAX_TEXT_LENGTH ? this.active.acceptedText : text;
    const previous = textBlock(source), shape = source.type === 'rect' || source.type === 'ellipse';
    // Empty shapes gain a complete block only in local draft metadata, never on opening.
    const props = shape ? { text: draft, align: previous?.align ?? 'center', autoSize: false as const, verticalAlign: previous?.verticalAlign ?? 'middle' }
      : { ...source.props, text: draft };
    const element = deriveElementGeometry({ ...source, props } as TextElement) as TextElement;
    const block = textBlock(element)!;
    const camera = this.options.session.getState().camera;
    const canvas = this.options.canvas.getBoundingClientRect();
    const parent = this.options.canvas.parentElement!.getBoundingClientRect();
    const width = Math.max(1, element.w - block.insetX * 2), lineHeight = element.style.fontSize * TEXT_LINE_HEIGHT;
    Object.assign(this.active.wrapper.style, {
      left: `${canvas.left - parent.left + canvas.width / 2 + (element.x + element.w / 2 - camera.x) * camera.zoom}px`,
      top: `${canvas.top - parent.top + canvas.height / 2 + (element.y + element.h / 2 - camera.y) * camera.zoom}px`,
      width: `${element.w}px`, height: `${element.h}px`,
      transform: `scale(${camera.zoom}) rotate(${element.rotation}rad) translate(-50%, -50%)`,
    });
    Object.assign(this.active.input.style, {
      position: 'absolute', left: `${block.insetX}px`, top: `${block.insetY}px`,
      width: element.type === 'text' && block.autoSize ? 'max-content' : `${shape ? Math.max(60, width) : width}px`,
      minWidth: `${Math.min(60, width)}px`, minHeight: `${lineHeight}px`,
      fontFamily: `"${resolvedFontFamily(element.style.fontFamily)}", "Noto Sans JP", sans-serif`,
      fontSize: `${element.style.fontSize}px`, lineHeight: String(TEXT_LINE_HEIGHT),
      color: element.style.color, textAlign: block.align,
      whiteSpace: element.type === 'text' && block.autoSize ? 'pre' : 'pre-wrap',
      outlineWidth: `${2 / camera.zoom}px`,
    });
    if (shape) {
      // The committed label keeps signed offsets/clipping. Native editing has a
      // reachable scroll origin and a one-line surface even for a tiny shape.
      Object.assign(this.active.input.style, {
        height: `${Math.max(lineHeight, element.h - block.insetY * 2)}px`,
        paddingTop: `${Math.max(0, textLayout(element).verticalOffset ?? 0)}px`,
      });
      this.active.input.dataset.empty = String(draft.length === 0 && !this.active.composing);
    }
  }

  /** Blur during an IME session must wait for compositionend. */
  commit(): void {
    if (this.active?.composing) { this.active.blurPending = true; return; }
    this.finish(true);
  }
  cancel(): void { this.finish(false); }

  private finish(commit: boolean): void {
    this.clearPositionTimer();
    const active = this.active;
    if (!active) return;
    const text = this.draft(); this.active = null;
    active.wrapper.remove(); this.options.renderer.setEditingText(null);
    this.options.onEditingChange?.(null);
    // Merely opening a native editor must not overwrite a peer's intervening text.
    if (text === active.originalText) return;
    const latest = this.options.board.read(active.id);
    if (editable(latest) && sourceText(latest) === text) return;
    if (this.options.isReadOnly()) { this.options.onError('Text changes were not saved because this board is now view only.'); return; }
    if (!editable(latest)) { this.options.onError('Text changes were not saved because this text was removed or changed by another edit.'); return; }
    if (!commit) { this.options.onError('Text changes were not saved because the editor was closed.'); return; }
    if (text.length > MAX_TEXT_LENGTH) { this.options.onError('Text was not saved because it exceeds the 50,000 character limit.'); return; }
    if (!isWellFormedString(text)) { this.options.onError('Text was not saved because it contains an incomplete or invalid character. Please enter the character again.'); return; }
    if (sourceText(latest) !== text) {
      try {
        if (latest.type === 'rect' || latest.type === 'ellipse') this.options.board.setShapeText(active.id, text);
        else this.options.board.update(active.id, { props: { ...latest.props, text } });
      }
      catch (error) { this.options.onError(error instanceof Error ? error.message : 'Text could not be saved.'); }
    }
  }

  destroy(): void { this.cancel(); this.unsubscribe(); this.unsubscribeSession(); this.resizeObserver.disconnect(); }
}
