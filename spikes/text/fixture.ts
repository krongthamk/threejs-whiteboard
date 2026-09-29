import { createElement, type Element } from '@whiteboard/model'

export const fixtureBounds = { x: 0, y: 0, w: 900, h: 560 }

export function mixedFixture(): Element[] {
  return [
    createElement('rect', { id: 'rectangle', x: 40, y: 50, w: 250, h: 150, index: 'a0', style: { fill: '#e7edff', stroke: '#4265cf', strokeWidth: 3 } }),
    createElement('ellipse', { id: 'ellipse', x: 360, y: 70, w: 200, h: 130, index: 'a1', style: { fill: '#d5eee2', stroke: '#297b5c', strokeWidth: 3 } }),
    createElement('sticky', { id: 'sticky', x: 640, y: 50, w: 210, h: 200, index: 'a2', style: { fill: '#fff0a6', stroke: '#e4bd40', fontSize: 24 }, props: { text: 'Ideas take shape', align: 'left', autoSize: false } }),
    createElement('text', { id: 'editable', x: 70, y: 295, w: 430, h: 96, index: 'a3', style: { fontSize: 32, color: '#172033' }, props: { text: 'A shared place to think', align: 'left', autoSize: true } }),
    createElement('stroke', { id: 'stroke', index: 'a4', style: { stroke: '#cf5574', strokeWidth: 8 }, props: { points: [70, 450, 0.4, 120, 410, 0.6, 180, 455, 0.8, 240, 415, 0.5, 310, 445, 0.5], simplified: false } }),
    createElement('connector', { id: 'connector', index: 'a5', style: { stroke: '#4265cf', strokeWidth: 3 }, props: { start: { elementId: 'rectangle', nx: 1, ny: 0.5, fallback: { x: 290, y: 125 } }, end: { elementId: 'ellipse', nx: 0, ny: 0.5, fallback: { x: 360, y: 135 } }, kind: 'elbow' } }),
  ]
}
