import { useState } from 'react';
import { Download } from 'lucide-react';
import type { EditorRuntime } from './runtime';
import { Modal } from './modal';
import { downloadExport, type ExportOptions } from './export';

export function ExportDialog({ runtime, title, onClose }: { runtime: EditorRuntime; title: string; onClose(): void }) {
  const [format, setFormat] = useState<ExportOptions['format']>('png');
  const [scope, setScope] = useState(runtime.session.getState().selectedIds.length ? 'selection' : 'board');
  const [scale, setScale] = useState(2), [transparent, setTransparent] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const selected = runtime.session.getState().selectedIds;
  return <Modal title="Export your board" onClose={() => !busy && onClose()}>
    <form className="simple-form export-form" onSubmit={event => { event.preventDefault(); setBusy(true); setError(''); void (async () => {
      try { const blob = await runtime.exporter.create({ format, selection: scope === 'selection' ? selected : undefined, scale, transparent, title }); downloadExport(blob, title, format); onClose(); }
      catch (cause) { setError(cause instanceof Error ? cause.message : 'The export could not be prepared.'); }
      finally { setBusy(false); }
    })(); }}>
      <fieldset className="export-formats"><legend>File format</legend>{(['png', 'svg', 'pdf'] as const).map(value => <button key={value} type="button" aria-pressed={value === format} disabled={busy} onClick={() => setFormat(value)}><span>{value.toUpperCase()}</span><small>{value === 'png' ? 'Image' : value === 'svg' ? 'Scalable vector' : 'Document'}</small></button>)}</fieldset>
      <label htmlFor="export-area">Include</label><select id="export-area" disabled={busy} value={scope} onChange={event => setScope(event.target.value)}><option value="board">Whole board</option><option value="selection" disabled={!selected.length}>Selection ({selected.length})</option></select>
      {format === 'png' && <><label htmlFor="export-scale">Resolution</label><select id="export-scale" disabled={busy} value={scale} onChange={event => setScale(Number(event.target.value))}>{[1, 2, 3, 4].map(value => <option key={value} value={value}>{value}×{value === 2 ? ' · Recommended' : ''}</option>)}</select></>}
      <label className="checkbox-label"><input type="checkbox" checked={transparent} disabled={busy} onChange={event => setTransparent(event.target.checked)} />Transparent background</label>
      <p className="dialog-description">{format === 'png' ? 'A crisp image, ready to drop into your next document.' : format === 'svg' ? 'Editable vector artwork with fonts and images included.' : 'A single page sized to your board, with vector shapes and text.'}</p>
      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="primary-button" type="submit" disabled={busy}>{busy ? 'Preparing export…' : `Download ${format.toUpperCase()}`}<Download size={16} /></button>
    </form>
  </Modal>;
}
