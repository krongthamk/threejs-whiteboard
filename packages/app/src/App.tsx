import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import {
  MousePointer2, Square, Circle, StickyNote, Hand, Undo2, Redo2,
  Plus, Minus, Scan, ChevronDown, SquarePen, ArrowUpToLine, ArrowDownToLine,
  Copy, Trash2, X, Keyboard, Check, ArrowLeft, LogOut, Users, Pencil,
  Type, PenLine, Eraser, ArrowUpRight, Download, ImagePlus,
} from 'lucide-react';
import { SCHEMA_VERSION, type ElementStyle } from '@whiteboard/model';
import { EditorRuntime, type BoardDiagnostics } from './runtime';
import type { Tool } from './session';
import { Modal } from './modal';
import { AccountAccess, type BoardAccess } from './account';
import { BoardConnection, type ConnectionStatus, type RemotePresence, type SyncBlockedState } from './collaboration';
import { api, ApiError } from './api';
import { ExportDialog } from './export-dialog';
import { Minimap } from './minimap';
import { BoardErrorBoundary } from './error-boundary';

const tools = [
  { id: 'select', name: 'Select', key: 'V', icon: MousePointer2 },
  { id: 'rect', name: 'Rectangle', key: 'R', icon: Square },
  { id: 'ellipse', name: 'Ellipse', key: 'O', icon: Circle },
  { id: 'sticky', name: 'Sticky note', key: 'N', icon: StickyNote },
  { id: 'text', name: 'Text', key: 'T', icon: Type },
  { id: 'connector', name: 'Connector', key: 'C', icon: ArrowUpRight },
  { id: 'draw', name: 'Draw', key: 'P', icon: PenLine },
  { id: 'eraser', name: 'Eraser', key: 'E', icon: Eraser },
  { id: 'pan', name: 'Pan', key: 'H', icon: Hand },
] satisfies { id: Tool; name: string; key: string; icon: typeof Square }[];
const fills = ['#ffffff', '#fff0ad', '#dbe9ff', '#dff3e5', '#f9dfe9', '#e8e1fa'];

export function App() {
  const localTest = import.meta.env.VITE_TEST_HOOKS === '1' && new URLSearchParams(location.search).has('local');
  if (localTest) return <BoardErrorBoundary><EditorBoard /></BoardErrorBoundary>;
  return <AccountAccess>{access => <BoardErrorBoundary key={access.board.id}><EditorBoard access={access} /></BoardErrorBoundary>}</AccountAccess>;
}

function EditorBoard({ access }: { access?: BoardAccess }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [runtime, setRuntime] = useState<EditorRuntime | null>(null);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState('');
  const [diagnostics, setDiagnostics] = useState<BoardDiagnostics | null>(null);
  const [syncBlocked, setSyncBlocked] = useState<SyncBlockedState | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [connectionRevision, setConnectionRevision] = useState(0);
  const [shortcuts, setShortcuts] = useState(false);
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [readOnly, setReadOnly] = useState(access?.board.role === 'viewer');
  const [peers, setPeers] = useState<Pick<RemotePresence, 'clientId' | 'name' | 'color'>[]>([]);
  const [dialog, setDialog] = useState<'share' | 'rename' | 'export' | null>(null);
  const connectionRef = useRef<BoardConnection | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false, instance: EditorRuntime | undefined, connection: BoardConnection | undefined;
    let unsubscribe: (() => void) | undefined;
    let latestPresence: RemotePresence[] = [];
    let currentReadOnly = access?.board.role === 'viewer';
    setDiagnostics(null);
    setSyncBlocked(null); setConfirmDiscard(false);
    const presence = () => {
      if (!instance || !connection) return;
      const { camera, selectedIds } = instance.session.getState(), bounds = canvas.getBoundingClientRect();
      connection.setPresence({ selection: selectedIds, viewport: { x: camera.x - bounds.width / camera.zoom / 2, y: camera.y - bounds.height / camera.zoom / 2, w: bounds.width / camera.zoom, h: bounds.height / camera.zoom } });
    };
    const pointer = (event: PointerEvent) => {
      if (!instance || !connection) return;
      const bounds = canvas.getBoundingClientRect(), camera = instance.session.getState().camera;
      connection.setPresence({ cursor: { x: camera.x + (event.clientX - bounds.left - bounds.width / 2) / camera.zoom, y: camera.y + (event.clientY - bounds.top - bounds.height / 2) / camera.zoom } });
    };
    const leave = () => connection?.setPresence({ cursor: null });
    void (async () => {
      try {
        if (access) connection = await BoardConnection.open(access.board, access.session, {
          onStatus: value => { if (!cancelled) setStatus(value); },
          onReadOnly: value => { currentReadOnly = value; if (!cancelled) { setReadOnly(value); if (instance) { instance.readOnly = value; if (value) instance.textEditor.cancel(); } } },
          onPresence: values => {
            if (cancelled) return;
            latestPresence = values; instance?.renderer.setPresence(values);
            const roster = values.map(({ clientId, name, color }) => ({ clientId, name, color }));
            setPeers(previous => JSON.stringify(previous) === JSON.stringify(roster) ? previous : roster);
          },
          onError: message => { if (!cancelled) setError(message); },
          onSyncBlocked: value => { if (!cancelled) setSyncBlocked(value); },
          onPermissionChange: reason => {
            if (cancelled) return;
            currentReadOnly = true; setReadOnly(true); setStatus('reconnecting');
            if (instance) { instance.readOnly = true; instance.destroy(); }
            setRuntime(null); void connection?.destroy();
            setSyncBlocked(null); setConfirmDiscard(false);
            setError(reason === 'invalid-document-update'
              ? 'The server rejected invalid board changes. Unaccepted local changes were discarded while the board refreshes.'
              : reason === 'session-expired' || reason === 'session-revoked'
                ? 'Your session ended. Sign in again. Your local work is kept on this device.'
              : reason === 'local-changes-discarded' || reason === 'cache-reset'
                ? 'Local changes were discarded. Reopening the saved board.'
                : 'Your board permissions changed. Unaccepted local changes were discarded while the board refreshes.');
            void api.board(access.board.id).then(board => {
              if (!cancelled) { access.onBoardChange(board); setConnectionRevision(value => value + 1); }
            }).catch(cause => { if (!cancelled) {
              if (cause instanceof ApiError && cause.status === 401) access.onSessionExpired();
              else { setStatus('unauthorized'); setError(cause instanceof Error ? cause.message : 'The board could not reopen.'); }
            } });
          },
        });
        if (cancelled) { if (connection) { await connection.destroy(); connection.board.destroy(); } return; }
        connectionRef.current = connection ?? null;
        instance = new EditorRuntime({ canvas, board: connection?.board, boardId: access?.board.id,
          resolveAsset: access ? assetId => api.assetUrl(access.board.id, assetId) : undefined,
          onChange: () => setRevision(value => value + 1), onError: message => { if (!cancelled) setError(message); }, onEditText: () => {},
          onEditingChange: id => connection?.setPresence({ editingTextId: id }),
          onAssetBusy: setUploading,
          onDiagnosticsChange: value => { if (!cancelled) setDiagnostics(value); },
        });
        instance.readOnly = currentReadOnly;
        instance.renderer.setPresence(latestPresence);
        unsubscribe = instance.session.subscribe(presence);
        presence(); setRuntime(instance);
        canvas.addEventListener('pointermove', pointer); canvas.addEventListener('pointerleave', leave);
        if (import.meta.env.DEV || import.meta.env.VITE_TEST_HOOKS === '1') Object.assign(window, { whiteboard: instance, whiteboardConnection: connection });
      } catch (cause) { if (!cancelled) setError(cause instanceof Error ? cause.message : 'The board could not open. Please try again.'); }
    })();
    return () => {
      cancelled = true; unsubscribe?.(); canvas.removeEventListener('pointermove', pointer); canvas.removeEventListener('pointerleave', leave);
      connectionRef.current = null;
      if (connection) void connection.destroy().finally(() => instance?.destroy()); else instance?.destroy();
    };
  }, [access?.board.id, access?.session.user.id, connectionRevision]);

  const unsupportedSchema = diagnostics !== null && diagnostics.schemaVersion !== undefined && diagnostics.schemaVersion !== SCHEMA_VERSION;
  const metadataTitle = runtime?.board.meta.get('title');
  const boardTitle = typeof metadataTitle === 'string' && metadataTitle.trim() ? metadataTitle : access?.board.title ?? 'Untitled board';
  const effectiveReadOnly = readOnly || unsupportedSchema || !!syncBlocked;
  const hiddenItems = diagnostics ? [
    diagnostics.invalidIds.size ? `${diagnostics.invalidIds.size} invalid element${diagnostics.invalidIds.size === 1 ? '' : 's'}` : '',
    diagnostics.malformedRecords ? `${diagnostics.malformedRecords} malformed record${diagnostics.malformedRecords === 1 ? '' : 's'}` : '',
  ].filter(Boolean).join(' and ') : '';
  const statusLabel = !access ? 'Local board' : status === 'limited' ? 'Sync paused' : status === 'live' ? 'Connected' : status === 'offline' ? 'Offline · edits on this device' : status === 'unauthorized' ? 'Access unavailable' : status === 'reconnecting' ? 'Reconnecting…' : 'Connecting…';
  return <main className="workspace">
    {/* A disposed renderer releases its WebGL context; each replacement owns a fresh canvas. */}
    <canvas key={`${access?.board.id ?? 'local'}:${access?.session.user.id ?? 'local'}:${connectionRevision}`} ref={canvasRef} className="board-canvas" aria-label="Whiteboard canvas" tabIndex={0} />
    <input ref={fileInputRef} type="file" hidden multiple accept="image/png,image/jpeg,image/webp" aria-label="Import images" onChange={event => { const files = [...(event.target.files ?? [])]; event.target.value = ''; if (runtime && files.length) void runtime.assets.importFiles(files); }} />
    <header className="board-header surface">
      {access ? <button className="icon-button board-back" aria-label="Back to boards" title="Back to boards" onClick={access.onBack}><ArrowLeft size={20} /></button> : <div className="brand-mark" aria-hidden="true"><SquarePen size={22} strokeWidth={1.7} /></div>}
      <div className="board-heading"><span className="workspace-label">YOUR WORKSPACE</span><h1>{boardTitle}</h1></div>
      <div className={`board-status status-${status}`} role="status"><span className="status-dot" />{statusLabel}{effectiveReadOnly && <span className="view-only">View only</span>}</div>
      <button className="icon-button help-button" onClick={() => setShortcuts(true)} aria-label="Keyboard shortcuts" title="Keyboard shortcuts"><Keyboard size={19} /></button>
    </header>
    <div className="board-actions surface">
      <div className="peer-roster" aria-label="Other people on this board">{peers.slice(0, 4).map(peer => <span key={peer.clientId} className="peer-avatar" style={{ background: peer.color }} title={peer.name} aria-label={peer.name}>{peer.name.slice(0, 1).toUpperCase()}</span>)}{peers.length > 4 && <span className="more-peers">+{peers.length - 4}</span>}</div>
      {access && !effectiveReadOnly && <button className="icon-button" aria-label="Rename board" title="Rename board" onClick={() => setDialog('rename')}><Pencil size={17} /></button>}
      {access?.board.role === 'owner' && <button className="share-button" onClick={() => setDialog('share')}><Users size={16} />Share</button>}
      {access && !effectiveReadOnly && <button className="icon-button" aria-label="Add images" title="Add images" disabled={uploading || !runtime} onClick={() => fileInputRef.current?.click()}><ImagePlus size={18} /></button>}
      <button className="icon-button" aria-label="Export board" title="Export board" disabled={!runtime} onClick={() => setDialog('export')}><Download size={18} /></button>
      {access && <button className="icon-button" aria-label="Sign out" title="Sign out" onClick={access.onSignOut}><LogOut size={17} /></button>}
    </div>
    {!runtime && !error && <div className="board-loading" role="status">Opening board…</div>}
    {uploading && <div className="upload-status surface" role="status">Adding images…</div>}
    {runtime && <BoardChrome runtime={runtime} revision={revision} readOnly={effectiveReadOnly} />}
    {(hiddenItems || unsupportedSchema || syncBlocked) && <div className="board-data-notice surface" role="status" aria-label="Board data notice">
      {hiddenItems && <p>{hiddenItems} {diagnostics!.invalidIds.size + diagnostics!.malformedRecords === 1 ? 'was' : 'were'} hidden. Other items remain available.</p>}
      {unsupportedSchema && <p>This board uses an unsupported format. Editing is disabled. Reload after updating the app.</p>}
      {syncBlocked && <>
        <p>{syncBlocked.reason === 'board-full' ? 'This board has reached its storage limit.' : syncBlocked.reason === 'update-too-large' ? 'Your pending changes exceed the server’s update limit.' : syncBlocked.reason === 'incomplete-update' ? 'The server needs a complete copy of your pending changes. Retry sync to resend them.' : 'The server could not handle your pending changes right now.'} Sync and editing are paused. Your local work is kept on this device and can still be exported.</p>
        {syncBlocked.reason === 'update-too-large' && <p>Export your work before discarding local changes to reopen the saved board.</p>}
        <div className="sync-recovery-actions">
          <button className="board-reload" disabled={!runtime} onClick={() => setDialog('export')}>Export local work</button>
          {syncBlocked.retryable && <button className="board-reload" disabled={syncBlocked.retrying} onClick={() => connectionRef.current?.retrySync()}>{syncBlocked.retrying ? 'Retrying sync…' : 'Retry sync'}</button>}
          <button className="board-reload" disabled={syncBlocked.retrying} onClick={() => setConfirmDiscard(true)}>Discard local changes and reopen</button>
        </div>
      </>}
    </div>}
    {confirmDiscard && <Modal title="Discard local changes?" onClose={() => setConfirmDiscard(false)}>
      <p>Unsynced changes on this device will be permanently discarded. The board will reopen from the server’s saved version. Export your local work first if you want to keep it.</p>
      <div className="sync-recovery-actions"><button className="board-reload" onClick={() => setConfirmDiscard(false)}>Keep local changes</button><button className="board-reload" onClick={() => { setConfirmDiscard(false); connectionRef.current?.discardLocalChanges(); }}>Discard and reopen saved board</button></div>
    </Modal>}
    {dialog === 'export' && runtime && <ExportDialog runtime={runtime} title={boardTitle} onClose={() => setDialog(null)} />}
    {dialog && dialog !== 'export' && access && <BoardSettings access={access} title={boardTitle} kind={dialog} onClose={() => setDialog(null)} />}
    {error && <div className="error-banner" role="alert"><span>{error}</span><button className="board-reload" onClick={() => window.location.reload()}>Reload board</button><button className="icon-button" onClick={() => setError('')} aria-label="Dismiss error"><X size={16} /></button></div>}
    {shortcuts && <Modal title="Keep your ideas moving" className="shortcut-dialog" onClose={() => setShortcuts(false)}>
      <dl className="shortcut-list"><dt>Select</dt><dd><kbd>V</kbd></dd><dt>Rectangle / Ellipse / Note</dt><dd><kbd>R</kbd> <kbd>O</kbd> <kbd>N</kbd></dd><dt>Pan</dt><dd><kbd>Space</kbd> + drag</dd><dt>Zoom</dt><dd><kbd>⌘</kbd> + scroll</dd><dt>Undo / Redo</dt><dd><kbd>⌘ Z</kbd> / <kbd>⌘ ⇧ Z</kbd></dd><dt>Duplicate</dt><dd><kbd>⌘ D</kbd></dd><dt>Move / Move 10 px</dt><dd><kbd>↑</kbd> / <kbd>⇧ ↑</kbd></dd><dt>Delete</dt><dd><kbd>⌫</kbd></dd></dl>
    </Modal>}
  </main>;
}

function BoardChrome({ runtime, revision, readOnly }: { runtime: EditorRuntime; revision: number; readOnly: boolean }) {
  const state = useStore(runtime.session);
  const selected = useMemo(() => state.selectedIds.flatMap(id => { const element = runtime.controller.hitIndex.elements.get(id); return element ? [element] : []; }), [runtime, state.selectedIds, revision]);
  const style = selected[0]?.style ?? state.style;
  const shapeTool = ['rect', 'ellipse', 'sticky'].includes(state.tool);
  const showProperties = selected.length > 0 || shapeTool || ['text', 'draw', 'connector'].includes(state.tool);
  const showFill = shapeTool || selected.some(element => ['rect', 'ellipse', 'sticky'].includes(element.type));
  const showStroke = shapeTool || ['draw', 'connector'].includes(state.tool) || selected.some(element => !['text', 'image'].includes(element.type));
  const showFont = ['sticky', 'text'].includes(state.tool) || selected.some(element => element.type === 'text' || element.type === 'sticky');
  const connector = selected.find(element => element.type === 'connector');
  const showConnector = state.tool === 'connector' || !!connector;
  const count = runtime.elementCount;
  const canUndo = runtime.board.undoManager.undoStack.length > 0;
  const canRedo = runtime.board.undoManager.redoStack.length > 0;
  const changeStyle = (patch: Partial<ElementStyle>) => runtime.applyStyle(patch);

  return <>
    <Minimap runtime={runtime} revision={revision} />
    <nav className="tool-rail surface" aria-label="Drawing tools">
      {tools.map(({ id, name, key, icon: Icon }) => <button key={id} className={`tool-button ${state.tool === id ? 'active' : ''}`} title={`${name} (${key})`} aria-label={name} aria-pressed={state.tool === id} disabled={readOnly && !['select', 'pan'].includes(id)} onClick={() => runtime.session.setState({ tool: id })}>
        <Icon size={21} strokeWidth={1.7} /><span className="tool-tooltip">{name}<kbd>{key}</kbd></span>
      </button>)}
    </nav>

    {showProperties && !readOnly && <aside className="properties-panel surface" aria-label="Selection properties">
      <div className="panel-heading"><h2>{selected.length ? `${selected.length} selected` : tools.find(tool => tool.id === state.tool)?.name}</h2><span className="property-marker" /></div>
      {showFill && <fieldset><legend>Fill</legend><div className="color-grid">
        {fills.map(fill => <button key={fill} className={`color-swatch ${style.fill === fill ? 'chosen' : ''}`} style={{ background: fill }} aria-label={`Fill ${fill}`} aria-pressed={style.fill === fill} onClick={() => changeStyle({ fill })}>{style.fill === fill && <Check size={14} />}</button>)}
        <label className="custom-color" title="Custom fill"><ColorField label="Custom fill" value={style.fill} onCommit={fill => changeStyle({ fill })} /><Plus size={15} /></label>
      </div></fieldset>}
      {showStroke && <>
        <div className="property-row"><label htmlFor="stroke-color">Stroke</label><ColorField id="stroke-color" label="Stroke color" value={style.stroke} onCommit={stroke => changeStyle({ stroke })} /></div>
        <div className="property-row"><label htmlFor="stroke-width">Width</label><NumberField id="stroke-width" value={style.strokeWidth} min={0} max={32} unit="px" onCommit={strokeWidth => changeStyle({ strokeWidth })} /></div>
      </>}
      <div className="property-row"><label htmlFor="opacity">Opacity</label><NumberField id="opacity" value={Math.round(style.opacity * 100)} min={0} max={100} unit="%" onCommit={value => changeStyle({ opacity: value / 100 })} /></div>
      {showFont && <>
        <div className="property-row"><label htmlFor="font-family">Font</label><select id="font-family" className="font-select" value={style.fontFamily} onChange={event => changeStyle({ fontFamily: event.target.value })}><option value="Inter">Inter</option><option value="IBM Plex Mono">Mono</option></select></div>
        <div className="property-row"><label htmlFor="font-size">Size</label><NumberField id="font-size" value={style.fontSize} min={8} max={256} unit="px" onCommit={fontSize => changeStyle({ fontSize })} /></div>
        <div className="property-row"><label htmlFor="text-color">Text</label><ColorField id="text-color" label="Text color" value={style.color} onCommit={color => changeStyle({ color })} /></div>
      </>}
      {showConnector && <div className="connector-options" role="group" aria-label="Connector shape">{(['straight', 'elbow'] as const).map(kind => <button key={kind} aria-pressed={(connector?.type === 'connector' ? connector.props.kind : state.connectorKind) === kind} onClick={() => {
        runtime.session.setState({ connectorKind: kind });
        runtime.board.transact(() => { for (const element of selected) if (element.type === 'connector') runtime.board.update(element.id, { props: { ...element.props, kind } }); });
      }}>{kind === 'straight' ? 'Straight' : 'Elbow'}</button>)}</div>}
      {!!selected.length && <div className="selection-actions">
        <button className="icon-button" aria-label="Bring to front" title="Bring to front" onClick={() => runtime.controller.reorder('front')}><ArrowUpToLine size={18} /></button>
        <button className="icon-button" aria-label="Send to back" title="Send to back" onClick={() => runtime.controller.reorder('back')}><ArrowDownToLine size={18} /></button>
        <button className="icon-button" aria-label="Duplicate selection" title="Duplicate selection (⌘ D)" onClick={() => runtime.controller.duplicateSelection()}><Copy size={17} /></button>
        <button className="icon-button danger" aria-label="Delete selection" title="Delete selection" onClick={() => runtime.controller.deleteSelection()}><Trash2 size={17} /></button>
      </div>}
    </aside>}

    {count === 0 && <div className="empty-board"><div className="empty-glyph" aria-hidden="true"><Square size={25} /><Circle size={25} /><StickyNote size={25} /></div><h2>A little room to think.</h2><p>Choose a tool and make your first mark.</p><span>Drag to draw · Space to move around</span></div>}

    <div className="history-controls surface" aria-label="History"><button className="icon-button" aria-label="Undo" title="Undo (⌘ Z)" disabled={readOnly || !canUndo} onClick={() => runtime.controller.undo()}><Undo2 size={20} /></button><button className="icon-button" aria-label="Redo" title="Redo (⌘ ⇧ Z)" disabled={readOnly || !canRedo} onClick={() => runtime.controller.redo()}><Redo2 size={20} /></button></div>
    <div className="tool-hint" aria-live="polite">{readOnly ? 'View only · Pan and zoom to explore' : state.tool === 'select' ? 'Click to select · Drag to move · Shift to add' : state.tool === 'pan' ? 'Drag to move around' : 'Drag to create · Escape to cancel'}</div>
    <div className="zoom-controls surface"><button className="icon-button" aria-label="Zoom out" onClick={() => runtime.controller.setZoom(state.camera.zoom / 1.25)}><Minus size={17} /></button><button className="zoom-value" aria-label="Reset zoom to 100 percent" title="Reset to 100%" onClick={() => runtime.controller.setZoom(1)}>{Math.round(state.camera.zoom * 100)}%<ChevronDown size={12} /></button><button className="icon-button" aria-label="Zoom in" onClick={() => runtime.controller.setZoom(state.camera.zoom * 1.25)}><Plus size={17} /></button><span className="control-divider" /><button className="icon-button" aria-label="Zoom to fit" title="Zoom to fit" onClick={() => runtime.controller.zoomToFit()}><Scan size={18} /></button></div>
  </>;
}

/** A typed style value is one gesture; unfinished digits never reach the document. */
function NumberField({ id, value, min, max, unit, onCommit }: { id: string; value: number; min: number; max: number; unit: string; onCommit(value: number): void }) {
  const [draft, setDraft] = useState(String(value));
  const editing = useRef(false), cancelled = useRef(false);
  useEffect(() => { if (!editing.current) setDraft(String(value)); }, [value]);
  return <div className="number-field"><input id={id} type="number" min={min} max={max} step="1" value={draft}
    onFocus={() => { editing.current = true; cancelled.current = false; }}
    onChange={event => setDraft(event.target.value)}
    onBlur={() => {
      editing.current = false;
      const number = draft.trim() === '' ? NaN : Number(draft), next = Math.max(min, Math.min(max, number));
      if (!cancelled.current && Number.isFinite(next) && next !== value) onCommit(next);
      setDraft(String(!cancelled.current && Number.isFinite(next) ? next : value));
    }}
    onKeyDown={event => {
      event.stopPropagation();
      if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); }
      if (event.key === 'Escape') { event.preventDefault(); cancelled.current = true; event.currentTarget.blur(); }
    }} /><span>{unit}</span></div>;
}

/** Native change fires when the color picker commits; input events are only its draft. */
function ColorField({ id, label, value, onCommit }: { id?: string; label: string; value: string; onCommit(value: string): void }) {
  const ref = useRef<HTMLInputElement>(null);
  const supported = /^#[0-9a-f]{6}$/i.test(value) ? value : '#ffffff';
  useEffect(() => { if (ref.current) ref.current.value = supported; }, [supported]);
  useEffect(() => {
    const input = ref.current!;
    const commit = () => { if (input.value !== value) onCommit(input.value); };
    input.addEventListener('change', commit); return () => input.removeEventListener('change', commit);
  }, [value, onCommit]);
  return <input ref={ref} id={id} type="color" aria-label={label} defaultValue={supported} />;
}

function BoardSettings({ access, title, kind, onClose }: { access: BoardAccess; title: string; kind: 'share' | 'rename'; onClose(): void }) {
  const [value, setValue] = useState(kind === 'rename' ? title : '');
  const [role, setRole] = useState<'editor' | 'viewer'>('editor');
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState('');
  return <Modal title={kind === 'rename' ? 'Rename board' : 'Share this board'} onClose={onClose}>
    <form className="simple-form" onSubmit={event => { event.preventDefault(); setBusy(true); setError(''); setMessage(''); void (async () => {
      try {
        if (kind === 'rename') { access.onBoardChange(await api.renameBoard(access.board.id, value.trim())); onClose(); }
        else { await api.membership(access.board.id, value.trim(), role); setMessage(`Access granted to ${value.trim()}.`); setValue(''); }
      } catch (cause) { setError(cause instanceof Error ? cause.message : 'The change could not be saved.'); }
      finally { setBusy(false); }
    })(); }}>
      {kind === 'share' && <p className="dialog-description">Give an existing workspace account access to this board.</p>}
      <label htmlFor="board-setting">{kind === 'rename' ? 'Board name' : 'Username'}</label><input autoFocus id="board-setting" required maxLength={120} value={value} onChange={event => setValue(event.target.value)} />
      {kind === 'share' && <><label htmlFor="member-role">Permission</label><select id="member-role" value={role} onChange={event => setRole(event.target.value as 'editor' | 'viewer')}><option value="editor">Can edit</option><option value="viewer">Can view</option></select></>}
      {error && <p className="form-error" role="alert">{error}</p>}{message && <p className="form-success" role="status">{message}</p>}
      <button className="primary-button" disabled={busy || !value.trim()} type="submit">{busy ? 'Saving…' : kind === 'rename' ? 'Save name' : 'Grant access'}</button>
      {kind === 'share' && <button className="secondary-button" disabled={busy || !value.trim()} type="button" onClick={() => {
        setBusy(true); setError(''); setMessage('');
        const username = value.trim();
        void api.removeMember(access.board.id, username).then(() => { setMessage(`Access removed for ${username}.`); setValue(''); })
          .catch(cause => setError(cause instanceof Error ? cause.message : 'Access could not be removed.'))
          .finally(() => setBusy(false));
      }}>Remove access</button>}
    </form>
  </Modal>;
}
