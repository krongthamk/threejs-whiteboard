import { describe, expect, it, vi } from 'vitest';
import { BoardDocument, bindToElement, resolveBinding } from '../src/index.js';

describe('connector move and copy bindings', () => {
  it('keeps bound endpoints on standalone moves, translates free endpoints and follows later target moves', () => {
    const board = new BoardDocument(), target = board.create('rect', { id: 'target', x: 10, y: 20 });
    const binding = bindToElement(target, 1, .5);
    const connector = board.create('connector', { id: 'connector', props: { start: binding, end: { x: 500, y: 200 }, kind: 'straight' } });
    board.undoManager.clear(); const readAll = vi.spyOn(board, 'readAll');
    board.move([connector.id], { x: 30, y: 40 });
    expect(board.read(connector.id)!.props).toMatchObject({ start: binding, end: { x: 530, y: 240 } });
    expect(board.undoManager.undoStack).toHaveLength(1);
    board.undoManager.undo(); expect(board.read(connector.id)).toEqual(connector);
    board.undoManager.redo();
    board.move([target.id], { x: 50, y: 60 });
    expect(resolveBinding(binding, new Map([[target.id, board.read(target.id)!]]))).toEqual({ x: 220, y: 130 });
    expect(board.read(connector.id)!.props).toMatchObject({ start: binding });
    expect(readAll).not.toHaveBeenCalled(); board.destroy();
  });

  it('shifts and unbinds standalone copies at the latest resolved target, including missing-target fallbacks', () => {
    const board = new BoardDocument(), target = board.create('rect', { id: 'target', x: 10, y: 20 });
    const connector = board.create('connector', { id: 'connector', props: { start: bindToElement(target, 1, .5),
      end: { elementId: 'missing', nx: .5, ny: .5, fallback: { x: 500, y: 200 } }, kind: 'elbow' } });
    board.move([target.id], { x: 50, y: 60 }); board.undoManager.clear(); const readAll = vi.spyOn(board, 'readAll');
    const [id] = board.duplicate([connector.id], { x: 30, y: 40 });
    const copy = board.read(id!)!;
    expect(copy.props).toMatchObject({ start: { x: 250, y: 170 }, end: { x: 530, y: 240 } });
    expect(copy.props).not.toHaveProperty('start.elementId'); expect(copy.props).not.toHaveProperty('end.elementId');
    expect(board.read(connector.id)).toEqual(connector); expect(board.undoManager.undoStack).toHaveLength(1);
    board.undoManager.undo(); expect(board.read(id!)).toBeUndefined(); board.undoManager.redo(); expect(board.read(id!)).toEqual(copy);
    board.move([target.id], { x: 100, y: 100 }); expect(board.read(id!)).toEqual(copy);
    expect(readAll).not.toHaveBeenCalled(); board.destroy();
  });

  it('remaps copied targets, preserves bindings during group moves and translates free endpoints', () => {
    const board = new BoardDocument(), target = board.create('rect', { id: 'target', x: 10, y: 20 });
    const binding = bindToElement(target, 1, .5);
    if (!('elementId' in binding)) throw new Error('Expected a target binding');
    const connector = board.create('connector', { id: 'connector', props: { start: binding, end: { x: 500, y: 200 }, kind: 'straight' } });
    board.move([target.id, connector.id], { x: 10, y: 20 });
    expect(board.read(connector.id)!.props).toMatchObject({ start: binding, end: { x: 510, y: 220 } });
    const [targetId, connectorId] = board.duplicate([target.id, connector.id], { x: 30, y: 40 });
    const copied = board.read(connectorId!)!;
    expect(copied.props).toMatchObject({ start: { ...binding, elementId: targetId, fallback: { x: binding.fallback.x + 30, y: binding.fallback.y + 40 } }, end: { x: 540, y: 260 } });
    board.move([targetId!], { x: 70, y: 80 }); expect(board.read(connectorId!)!.props).toEqual(copied.props);
    board.destroy();
  });

  it('preserves a missing-target binding and fallback on move', () => {
    const board = new BoardDocument(), binding = { elementId: 'missing', nx: .5, ny: .5, fallback: { x: 10, y: 20 } };
    const connector = board.create('connector', { props: { start: binding, end: { x: 30, y: 40 }, kind: 'straight' } });
    board.move([connector.id], { x: 20, y: 30 });
    expect(board.read(connector.id)!.props).toMatchObject({ start: binding, end: { x: 50, y: 70 } }); board.destroy();
  });
});
