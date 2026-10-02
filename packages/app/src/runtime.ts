import { BoardDocument, SCHEMA_VERSION, type ElementStyle } from '@whiteboard/model';
import { createRenderer, type ThreeRenderer } from '@whiteboard/renderer';
import { EditorController } from './controller';
import { createSession, type SessionStore } from './session';
import { BoardTextEditor } from './text-editor';
import { BoardExporter } from './export';
import { BoardAssets } from './assets';

export interface BoardDiagnostics {
  invalidIds: ReadonlySet<string>;
  malformedRecords: number;
  schemaVersion: unknown;
}

export interface RuntimeOptions {
  canvas: HTMLCanvasElement;
  boardId?: string;
  board?: BoardDocument;
  resolveAsset?(assetId: string): string | Promise<string>;
  onChange(): void;
  onEditText(id: string): void;
  onEditingChange?(id: string | null): void;
  onAssetBusy?(busy: boolean): void;
  onDiagnosticsChange?(diagnostics: BoardDiagnostics): void;
  onError(message: string): void;
}

export class EditorRuntime {
  readonly board: BoardDocument;
  readonly renderer: ThreeRenderer;
  readonly session: SessionStore;
  readonly controller: EditorController;
  readonly textEditor: BoardTextEditor;
  readonly exporter: BoardExporter;
  readonly assets: BoardAssets;
  private permissionReadOnly = false;
  get readOnly(): boolean {
    const version = this.board.schemaVersion;
    return this.permissionReadOnly || version !== undefined && version !== SCHEMA_VERSION;
  }
  set readOnly(value: boolean) { this.permissionReadOnly = value; }
  private elementIds = new Set<string>();
  get elementCount(): number { return this.elementIds.size; }
  private stopped = false;
  private frame = 0;
  private observer: ResizeObserver;
  private unsubscribe: () => void;
  private unsubscribeSession: () => void;
  private readonly onChange: () => void;

  constructor(options: RuntimeOptions) {
    this.onChange = options.onChange;
    this.board = options.board ?? new BoardDocument();
    this.exporter = new BoardExporter(this.board, options.resolveAsset);
    this.session = createSession(options.boardId ?? 'local');
    this.renderer = createRenderer({
      canvas: options.canvas, fontUrl: '/fonts/inter-latin-400-normal.woff',
      monoFontUrl: '/fonts/ibm-plex-mono-latin-400-normal.woff',
      fallbackFontUrl: '/fonts/noto-sans-jp-400.woff', background: '#f7f9fc', grid: true,
      pixelRatio: Math.min(devicePixelRatio, 2),
      resolveAsset: options.resolveAsset,
    });
    const initialElements = this.board.readAll();
    const reportDiagnostics = () => options.onDiagnosticsChange?.({
      invalidIds: new Set(this.board.invalidIds), malformedRecords: this.board.malformedRecords,
      schemaVersion: this.board.schemaVersion,
    });
    reportDiagnostics();
    this.elementIds = new Set(initialElements.map(element => element.id));
    this.renderer.setElements(initialElements);
    this.renderer.setCamera(this.session.getState().camera);
    this.unsubscribe = this.board.subscribe(({ ids }) => {
      try {
        if (this.readOnly) this.textEditor?.cancel();
        const projected = [...ids].map(id => ({ id, element: this.board.read(id) }));
        const upserts = projected.flatMap(({ element }) => element ? [element] : []);
        const removals = projected.filter(({ element }) => !element).map(({ id }) => id);
        for (const element of upserts) this.elementIds.add(element.id);
        for (const id of removals) this.elementIds.delete(id);
        this.renderer.applyDiff(upserts, removals);
        const selectedIds = this.session.getState().selectedIds.filter(id => !!this.board.read(id));
        if (selectedIds.length !== this.session.getState().selectedIds.length) this.session.setState({ selectedIds });
        options.onChange();
      } catch (error) {
        options.onError(error instanceof Error ? error.message : 'The board could not update. Reload the board.');
      } finally { reportDiagnostics(); }
    });
    this.unsubscribeSession = this.session.subscribe((state, previous) => {
      try { if (state.camera !== previous.camera) this.renderer.setCamera(state.camera); }
      catch (error) { options.onError(error instanceof Error ? error.message : 'The canvas could not update. Reload the board.'); }
    });
    this.textEditor = new BoardTextEditor({
      canvas: options.canvas, board: this.board, renderer: this.renderer, session: this.session,
      isReadOnly: () => this.readOnly,
      onEditingChange: options.onEditingChange,
    });
    this.controller = new EditorController({
      canvas: options.canvas, board: this.board, renderer: this.renderer, session: this.session,
      onEditText: (id: string) => { this.textEditor.open(id); options.onEditText(id); }, isReadOnly: () => this.readOnly,
    });
    this.assets = new BoardAssets({ canvas: options.canvas, boardId: options.boardId ?? 'local', board: this.board, session: this.session,
      isReadOnly: () => this.readOnly, maxImageDimension: () => this.renderer.getMaxImageDimension(), onError: options.onError, onBusy: options.onAssetBusy });
    this.observer = new ResizeObserver(() => {
      try {
        const bounds = options.canvas.getBoundingClientRect();
        this.renderer.resize(Math.max(1, bounds.width), Math.max(1, bounds.height));
      } catch (error) { options.onError(error instanceof Error ? error.message : 'The canvas could not resize. Reload the board.'); }
    });
    this.observer.observe(options.canvas);
    const bounds = options.canvas.getBoundingClientRect();
    this.renderer.resize(Math.max(1, bounds.width), Math.max(1, bounds.height));
    const render = () => {
      if (this.stopped) return;
      try { this.renderer.render(); }
      catch (error) { options.onError(error instanceof Error ? error.message : 'The canvas could not render. Reload the board.'); return; }
      this.frame = requestAnimationFrame(render);
    };
    render();
  }

  applyStyle(patch: Partial<ElementStyle>): void {
    if (this.readOnly) return;
    this.session.setState({ style: { ...this.session.getState().style, ...patch } });
    this.board.updateStyle(this.session.getState().selectedIds, patch);
    this.onChange();
  }

  destroy(): void {
    if (this.stopped) return;
    this.stopped = true;
    cancelAnimationFrame(this.frame); this.observer.disconnect();
    this.assets.destroy(); this.textEditor.destroy(); this.controller.destroy(); this.unsubscribe(); this.unsubscribeSession();
    this.exporter.destroy(); this.renderer.dispose(); this.session.dispose(); this.board.destroy();
  }
}
