import { afterEach, expect, it, vi } from 'vitest';
import { createSession } from '../src/session';

afterEach(() => { vi.unstubAllGlobals(); });

it('clamps persisted camera coordinates before opening a board', () => {
  const setItem = vi.fn();
  vi.stubGlobal('localStorage', { getItem: () => JSON.stringify({ x: 1e12, y: -1e12, zoom: 100 }), setItem });
  const session = createSession('persisted-camera');
  expect(session.getState().camera).toEqual({ x: 1e6, y: -1e6, zoom: 64 });
  session.dispose();
  expect(JSON.parse(setItem.mock.calls[0]![1])).toEqual({ x: 1e6, y: -1e6, zoom: 64 });
});

it('bounds direct and functional camera updates before any subscriber can see them', () => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {} });
  const session = createSession('camera-updates'), changed = vi.fn();
  const stop = session.subscribe(state => changed({ ...state.camera }));
  session.setState({ camera: { x: 1e7, y: -1e7, zoom: 1 } });
  session.setState(state => ({ camera: { x: state.camera.x + 50, y: state.camera.y - 50, zoom: .001 } }));
  expect(changed.mock.calls.map(([camera]) => camera)).toEqual([
    { x: 1e6, y: -1e6, zoom: 1 }, { x: 1e6, y: -1e6, zoom: .02 },
  ]);
  session.setState({ ...session.getState(), camera: { x: -1e10, y: 1e10, zoom: 80 } }, true);
  expect(session.getState().camera).toEqual({ x: -1e6, y: 1e6, zoom: 64 });
  changed.mockClear(); session.setState(state => state);
  expect(changed).not.toHaveBeenCalled();
  stop(); session.dispose();
});

it('keeps finite coordinates when a caller supplies non-finite camera values', () => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {} });
  const session = createSession('invalid-camera');
  session.setState({ camera: { x: 120, y: -350, zoom: 2 } });
  session.setState({ camera: { x: NaN, y: Infinity, zoom: -Infinity } });
  expect(session.getState().camera).toEqual({ x: 120, y: -350, zoom: 2 });
  session.dispose();
});
