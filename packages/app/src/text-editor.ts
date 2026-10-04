import { BoardDocument, deriveElementGeometry, isWellFormedString, STICKY_TEXT_INSET, TEXT_LINE_HEIGHT, resolvedFontFamily, type Element } from '@whiteboard/model';
import type { ThreeRenderer } from '@whiteboard/renderer';
import type { SessionStore } from './session';

type TextElement = Extract<Element, { type: 'text' | 'sticky' }>;
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
  private active: { id: string; originalText: string; wrapper: HTMLDivElement; input: HTMLDivElement; composing: boolean; blurPending: boolean } | null = null;
  private unsubscribe: () => void;
  private unsubscribeSession: () => void;
  private resizeObserver: ResizeObserver;

  constructor(private options: TextEditorOptions) {
    this.unsubscribeSession = options.session.subscribe(() => this.position());
    this.unsubscribe = options.board.subscribe(({ ids }) => {
      if (!this.active || !ids.has(this.active.id)) return;
      const current = options.board.read(this.active.id);
      if (!current || (current.type !== 'text' && current.type !== 'sticky')) this.finish(false);
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
    if (!element || (element.type !== 'text' && element.type !== 'sticky')) return;
    const wrapper = document.createElement('div'), input = document.createElement('div');
    wrapper.className = 'text-editor-anchor'; input.className = 'native-text-editor';
    input.contentEditable = 'plaintext-only'; input.role = 'textbox'; input.spellcheck = true;
    input.setAttribute('aria-label', 'Edit text'); input.setAttribute('aria-multiline', 'true');
    // Chromium keeps a final caret line as an extra LF (or a terminal BR).
    // Start with the same representation so normalization also preserves saved trailing lines.
    input.textContent = element.props.text.endsWith('\n') ? `${element.props.text}\n` : element.props.text;
    wrapper.append(input); this.options.canvas.parentElement!.append(wrapper);
    this.active = { id, originalText: element.props.text, wrapper, input, composing: false, blurPending: false };
    this.options.renderer.setEditingText(id);
    this.options.onEditingChange?.(id);
    input.addEventListener('compositionstart', () => { if (this.active?.input === input) this.active.composing = true; });
    input.addEventListener('compositionend', () => {
      if (this.active?.input !== input) return;
      this.active.composing = false;
      if (this.active.blurPending) this.finish(true); else this.position();
    });
    input.addEventListener('blur', () => {
      if (this.active?.input !== input) return;
      if (this.active.composing) this.active.blurPending = true;
      else this.finish(true);
    });
    input.addEventListener('input', () => this.position());
    input.addEventListener('keydown', event => {
      event.stopPropagation();
      if (event.isComposing || this.active?.composing) return;
      if (event.key === 'Escape') { event.preventDefault(); this.finish(false); this.options.canvas.focus(); }
      else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); this.finish(true); this.options.canvas.focus(); }
    });
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'dblclick']) input.addEventListener(type, event => event.stopPropagation());
    this.position(); input.focus();
    const range = document.createRange(); range.selectNodeContents(input);
    const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
  }

  get editingId(): string | null { return this.active?.id ?? null; }

  private draft(): string {
    const text = this.active?.input.innerText.replace(/\r\n?/g, '\n') ?? '';
    // Remove one browser caret placeholder, never trim intentional whitespace or blank lines.
    return text.endsWith('\n') ? text.slice(0, -1) : text;
  }

  private position(): void {
    if (!this.active) return;
    const source = this.options.board.read(this.active.id);
    if (!source || (source.type !== 'text' && source.type !== 'sticky')) return;
    const element = deriveElementGeometry({ ...source, props: { ...source.props, text: this.draft() } }) as TextElement;
    const camera = this.options.session.getState().camera;
    const canvas = this.options.canvas.getBoundingClientRect();
    const parent = this.options.canvas.parentElement!.getBoundingClientRect();
    const inset = element.type === 'sticky' ? STICKY_TEXT_INSET : 0;
    Object.assign(this.active.wrapper.style, {
      left: `${canvas.left - parent.left + canvas.width / 2 + (element.x + element.w / 2 - camera.x) * camera.zoom}px`,
      top: `${canvas.top - parent.top + canvas.height / 2 + (element.y + element.h / 2 - camera.y) * camera.zoom}px`,
      width: `${element.w}px`, height: `${element.h}px`,
      transform: `scale(${camera.zoom}) rotate(${element.rotation}rad) translate(-50%, -50%)`,
    });
    Object.assign(this.active.input.style, {
      position: 'absolute', left: `${inset}px`, top: `${inset}px`,
      width: element.type === 'text' && element.props.autoSize ? 'max-content' : `${Math.max(1, element.w - inset * 2)}px`,
      minWidth: `${Math.min(60, Math.max(1, element.w - inset * 2))}px`, minHeight: `${element.style.fontSize * TEXT_LINE_HEIGHT}px`,
      fontFamily: `"${resolvedFontFamily(element.style.fontFamily)}", "Noto Sans JP", sans-serif`,
      fontSize: `${element.style.fontSize}px`, lineHeight: String(TEXT_LINE_HEIGHT),
      color: element.style.color, textAlign: element.props.align,
      whiteSpace: element.type === 'text' && element.props.autoSize ? 'pre' : 'pre-wrap',
      outlineWidth: `${2 / camera.zoom}px`,
    });
  }

  /** Blur during an IME session must wait for compositionend. */
  commit(): void {
    if (this.active?.composing) { this.active.blurPending = true; return; }
    this.finish(true);
  }
  cancel(): void { this.finish(false); }

  private finish(commit: boolean): void {
    const active = this.active;
    if (!active) return;
    const text = this.draft(); this.active = null;
    active.wrapper.remove(); this.options.renderer.setEditingText(null);
    this.options.onEditingChange?.(null);
    // Merely opening a native editor must not overwrite a peer's intervening text.
    if (!commit || this.options.isReadOnly() || text === active.originalText) return;
    if (!isWellFormedString(text)) { this.options.onError('Text was not saved because it contains an incomplete or invalid character. Please enter the character again.'); return; }
    const latest = this.options.board.read(active.id);
    if (latest && (latest.type === 'text' || latest.type === 'sticky') && latest.props.text !== text) {
      try { this.options.board.update(active.id, { props: { ...latest.props, text } }); }
      catch (error) { this.options.onError(error instanceof Error ? error.message : 'Text could not be saved.'); }
    }
  }

  destroy(): void { this.cancel(); this.unsubscribe(); this.unsubscribeSession(); this.resizeObserver.disconnect(); }
}
