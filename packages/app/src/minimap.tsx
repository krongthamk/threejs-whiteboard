import { useEffect, useMemo, useRef, useState } from 'react';
import { Map as MapIcon, X } from 'lucide-react';
import { useStore } from 'zustand';
import { contentBounds, getElementBounds } from '@whiteboard/model';
import type { EditorRuntime } from './runtime';

export function Minimap({ runtime, revision }: { runtime: EditorRuntime; revision: number }) {
  const [open, setOpen] = useState(false);
  return open ? <MinimapContent runtime={runtime} revision={revision} onClose={() => setOpen(false)} />
    : <div className="minimap-shell"><button className="icon-button surface" aria-label="Open minimap" title="Open minimap" onClick={() => setOpen(true)}><MapIcon size={18} /></button></div>;
}

function MinimapContent({ runtime, revision, onClose }: { runtime: EditorRuntime; revision: number; onClose(): void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState(() => runtime.renderer.webgl.domElement.getBoundingClientRect());
  useEffect(() => {
    const canvas = runtime.renderer.webgl.domElement;
    const observer = new ResizeObserver(() => setSize(canvas.getBoundingClientRect()));
    observer.observe(canvas); return () => observer.disconnect();
  }, [runtime]);
  const camera = useStore(runtime.session, state => state.camera);
  const elements = useMemo(() => runtime.board.readAll(), [runtime, revision]);
  const view = useMemo(() => {
    const raw = contentBounds(elements), padding = Math.max(40, Math.max(raw.w, raw.h) * .08);
    const box = { x: raw.x - padding, y: raw.y - padding, w: Math.max(100, raw.w + padding * 2), h: Math.max(100, raw.h + padding * 2) };
    const scale = Math.min(180 / box.w, 112 / box.h);
    return { box, scale, left: (180 - box.w * scale) / 2, top: (112 - box.h * scale) / 2 };
  }, [elements]);
  useEffect(() => {
    const canvas = ref.current; if (!canvas) return;
    const context = canvas.getContext('2d'); if (!context) return;
    context.clearRect(0, 0, 360, 224); context.save(); context.scale(2, 2);
    const map = new Map(elements.map(element => [element.id, element]));
    for (const element of elements) {
      const box = getElementBounds(element, map);
      context.globalAlpha = element.style.opacity;
      context.fillStyle = ['text', 'stroke', 'connector'].includes(element.type) ? element.style.color : element.type === 'image' ? '#9fb2d7' : element.style.fill;
      context.strokeStyle = element.style.stroke; context.lineWidth = .5;
      const x = view.left + (box.x - view.box.x) * view.scale, y = view.top + (box.y - view.box.y) * view.scale;
      context.fillRect(x, y, Math.max(1, box.w * view.scale), Math.max(1, box.h * view.scale));
      context.strokeRect(x, y, Math.max(1, box.w * view.scale), Math.max(1, box.h * view.scale));
    }
    context.restore();
  }, [elements, view]);
  const viewport = { x: view.left + (camera.x - size.width / camera.zoom / 2 - view.box.x) * view.scale, y: view.top + (camera.y - size.height / camera.zoom / 2 - view.box.y) * view.scale, width: size.width / camera.zoom * view.scale, height: size.height / camera.zoom * view.scale };
  return <div className="minimap-shell is-open surface"><div className="minimap-heading"><span>BOARD OVERVIEW</span><button className="icon-button" aria-label="Close minimap" onClick={onClose}><X size={14} /></button></div>
      <div className="minimap-view" role="button" tabIndex={0} aria-label="Minimap · drag to navigate, Enter to fit board"
        onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); runtime.controller.zoomToFit(); } }}
        onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); const rect = event.currentTarget.getBoundingClientRect(); runtime.session.setState({ camera: { ...camera, x: view.box.x + (event.clientX - rect.left - view.left) / view.scale, y: view.box.y + (event.clientY - rect.top - view.top) / view.scale } }); }}
        onPointerMove={event => { if (!event.currentTarget.hasPointerCapture(event.pointerId)) return; const rect = event.currentTarget.getBoundingClientRect(); runtime.session.setState({ camera: { ...runtime.session.getState().camera, x: view.box.x + (event.clientX - rect.left - view.left) / view.scale, y: view.box.y + (event.clientY - rect.top - view.top) / view.scale } }); }}>
        <canvas ref={ref} width={360} height={224} /><svg viewBox="0 0 180 112" aria-hidden="true"><rect {...viewport} fill="#5267ce14" stroke="#5267ce" strokeWidth={1.2} /></svg>
      </div>
  </div>;
}
