import { xml } from './xml.js';
import { arrowheadPoints, connectorPoints, contentBounds, strokeOutline } from './geometry.js';
import { compareElements } from './schema.js';
import type { Box, Element, Point } from './types.js';
import { positionFontRuns, resolvedFontFamily, textBlock, textLayout, STICKY_CORNER_RADIUS, type ShippedFontFamily } from './text-layout.js';

export interface SvgOptions {
  bounds?: Box;
  padding?: number;
  background?: string | null;
  /** Self-contained .woff/.ttf data URLs. The document never contains font bytes. */
  fonts?: readonly { family: string; dataUrl: string; weight?: number }[];
  assetUrl?: (assetId: string) => string | undefined;
  title?: string;
}

function n(value: number): string { return String(Math.round(value * 10000) / 10000); }
function path(points: readonly Point[], closed = false): string {
  return points.map((point, i) => `${i === 0 ? 'M' : 'L'}${n(point.x)} ${n(point.y)}`).join(' ') + (closed ? ' Z' : '');
}
function safeUrl(url: string): string {
  if (/^(https?:\/\/|\/|\.\/|\.\.\/|data:image\/(?:png|jpeg|webp|gif);base64,|blob:)/i.test(url)) return url;
  throw new Error('SVG asset URL must be an image data URL, HTTP URL or relative path');
}
function textSvg(element: Element, clipIndex?: number): string {
  const block = textBlock(element);
  if (!block) return '';
  const layout = textLayout(element), align = block.align;
  const x = align === 'left' ? element.x + block.insetX : align === 'center' ? element.x + element.w / 2 : element.x + element.w - block.insetX;
  const y = element.y + block.insetY + (layout.verticalOffset ?? 0) + element.style.fontSize;
  let previousFont: ShippedFontFamily | undefined;
  const lines = layout.lines.map((line, i) => {
    const runs = positionFontRuns(line.text, element.style.fontSize, element.style.fontFamily, previousFont);
    const left = x - line.width * (align === 'center' ? .5 : align === 'right' ? 1 : 0);
    previousFont = runs.at(-1)?.family ?? previousFont;
    return `<tspan data-text-line="${i}" x="${n(left)}" y="${n(y + i * element.style.fontSize * 1.25)}">${runs.map(run => `<tspan x="${n(left + run.x)}" font-family="${xml(run.family)}">${xml(run.text)}</tspan>`).join('')}</tspan>`;
  }).join('');
  const text = `<text x="${n(x)}" y="${n(y)}" fill="${xml(element.style.color)}" font-family="${xml(`'${resolvedFontFamily(element.style.fontFamily)}', 'Noto Sans JP'`)}" font-size="${n(element.style.fontSize)}" text-anchor="start" xml:space="preserve">${lines}</text>`;
  if (element.type !== 'rect' && element.type !== 'ellipse') return text;
  const id = `shape-label-clip-${clipIndex}`, width = Math.max(0, element.w - block.insetX * 2), height = Math.max(0, element.h - block.insetY * 2);
  // Fill and label share the outer rotation, but blend independently like the
  // renderer. IDs depend on ordered labels, never arbitrary document IDs.
  const clip = `<defs><clipPath id="${id}" clipPathUnits="userSpaceOnUse"><rect x="${n(element.x + block.insetX)}" y="${n(element.y + block.insetY)}" width="${n(width)}" height="${n(height)}"/></clipPath></defs>`;
  // Keep every line available to font coverage while hiding a zero-area label
  // explicitly; PDF consumers need not interpret an empty clipping rectangle.
  return `${clip}<g clip-path="url(#${id})" opacity="${n(element.style.opacity)}"${width === 0 || height === 0 ? ' display="none"' : ''}>${text}</g>`;
}

/** Pure, deterministic document serializer. No scene graph or browser state is read. */
export function documentToSvg(elements: readonly Element[], options: SvgOptions = {}): string {
  const padding = options.padding ?? 24;
  if (!Number.isFinite(padding) || padding < 0) throw new Error('SVG padding must be nonnegative');
  const raw = options.bounds ?? contentBounds(elements);
  const box = { x: raw.x - padding, y: raw.y - padding, w: Math.max(1, raw.w + padding * 2), h: Math.max(1, raw.h + padding * 2) };
  const map = new Map(elements.map(element => [element.id, element]));
  const fonts = (options.fonts ?? []).map(font => {
    if (!/^data:(?:font\/(?:woff|ttf)|application\/(?:font-woff|x-font-ttf));base64,[A-Za-z0-9+/=]+$/.test(font.dataUrl)) throw new Error('Embed a WOFF or TTF font data URL');
    if (font.weight !== undefined && (!Number.isFinite(font.weight) || font.weight < 1 || font.weight > 1000)) throw new Error('Invalid font weight');
    const family = font.family.replace(/[\\'\r\n]/g, character => `\\${character}`);
    return `@font-face{font-family:'${family}';src:url('${font.dataUrl}');font-weight:${font.weight ?? 400};}`;
  }).join('');
  let clipIndex = 0;
  const body = [...elements].sort(compareElements).map(element => {
    const labelClip = (element.type === 'rect' || element.type === 'ellipse') && textBlock(element) ? clipIndex++ : undefined;
    const { style: s } = element;
    const attributes = `fill="${xml(s.fill)}" stroke="${xml(s.stroke)}" stroke-width="${n(s.strokeWidth)}"${labelClip !== undefined ? ` opacity="${n(s.opacity)}"` : ''}`;
    let shape = '';
    if (element.type === 'rect' || element.type === 'sticky') shape = `<rect x="${n(element.x)}" y="${n(element.y)}" width="${n(element.w)}" height="${n(element.h)}"${element.type === 'sticky' ? ` rx="${STICKY_CORNER_RADIUS}"` : ''} ${attributes}/>${textSvg(element, labelClip)}`;
    else if (element.type === 'ellipse') shape = `<ellipse cx="${n(element.x + element.w / 2)}" cy="${n(element.y + element.h / 2)}" rx="${n(element.w / 2)}" ry="${n(element.h / 2)}" ${attributes}/>${textSvg(element, labelClip)}`;
    else if (element.type === 'text') shape = textSvg(element);
    else if (element.type === 'stroke') shape = `<path d="${path(strokeOutline(element), true)}" fill="${xml(s.stroke)}"/>`;
    else if (element.type === 'connector') shape = `<path d="${path(connectorPoints(element, map))}" fill="none" stroke="${xml(s.stroke)}" stroke-width="${n(s.strokeWidth)}" stroke-linecap="round" stroke-linejoin="round"/><path d="${path(arrowheadPoints(element, map), true)}" fill="${xml(s.stroke)}"/>`;
    else {
      const asset = options.assetUrl?.(element.props.assetId);
      shape = asset ? `<image x="${n(element.x)}" y="${n(element.y)}" width="${n(element.w)}" height="${n(element.h)}" href="${xml(safeUrl(asset))}" preserveAspectRatio="none"/>`
        : `<rect x="${n(element.x)}" y="${n(element.y)}" width="${n(element.w)}" height="${n(element.h)}" ${attributes}/>`;
    }
    const transform = element.type === 'stroke' || element.type === 'connector' || element.rotation === 0 ? '' : ` transform="rotate(${n(element.rotation * 180 / Math.PI)} ${n(element.x + element.w / 2)} ${n(element.y + element.h / 2)})"`;
    return `<g data-element-id="${xml(element.id)}" opacity="${labelClip !== undefined ? '1' : n(s.opacity)}"${transform}>${shape}</g>`;
  }).join('');
  const background = options.background === null ? '' : `<rect x="${n(box.x)}" y="${n(box.y)}" width="${n(box.w)}" height="${n(box.h)}" fill="${xml(options.background ?? '#ffffff')}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${n(box.w)}" height="${n(box.h)}" viewBox="${n(box.x)} ${n(box.y)} ${n(box.w)} ${n(box.h)}" role="img">${options.title ? `<title>${xml(options.title)}</title>` : ''}${fonts ? `<defs><style>${xml(fonts)}</style></defs>` : ''}${background}${body}</svg>`;
}
