import { BoardDocument, documentToSvg, hitTestElement, STICKY_TEXT_INSET, type Element } from '@whiteboard/model'
import { createRenderer } from '@whiteboard/renderer'
import { mixedFixture, fixtureBounds } from './fixture'
import { openTextEditor } from './overlay'
import './style.css'

const canvas = document.querySelector('canvas')!
const surface = document.querySelector<HTMLElement>('#surface')!
const status = document.querySelector<HTMLOutputElement>('#status')!
const board = new BoardDocument()
board.transact(() => {
  for (const element of mixedFixture()) board.create(element.type, element)
})
board.undoManager.clear()
const renderer = createRenderer({ canvas, fontUrl: '/fonts/inter-latin-400-normal.woff', background: '#ffffff', grid: false, pixelRatio: 1 })
renderer.resize(fixtureBounds.w, fixtureBounds.h)
renderer.setCamera({ x: fixtureBounds.w / 2, y: fixtureBounds.h / 2, zoom: 1 })
renderer.setElements(board.readAll())
let activeEditor: ReturnType<typeof openTextEditor> | undefined
let editingId: string | undefined
let commits = 0
const unsubscribe = board.subscribe(({ ids }) => {
  const upserts: Element[] = [], removals: string[] = []
  for (const id of ids) {
    const element = board.read(id)
    if (element) upserts.push(element)
    else removals.push(id)
  }
  renderer.applyDiff(upserts, removals)
})
function beginEdit(id: string) {
  if (editingId === id) return
  activeEditor?.commit()
  const element = board.read(id)
  if (!element || (element.type !== 'text' && element.type !== 'sticky')) return
  editingId = id
  const inset = element.type === 'sticky' ? STICKY_TEXT_INSET : 0
  renderer.setEditingText(id)
  const close = () => {
    activeEditor = undefined
    editingId = undefined
    renderer.setEditingText(null)
    const current = board.read(id)
    if (current) renderer.applyDiff([current])
  }
  activeEditor = openTextEditor({
    parent: surface, text: element.props.text,
    x: element.x + inset, y: element.y + inset,
    width: element.type === 'sticky' ? element.w - inset * 2 : Math.max(element.w, 480),
    fontSize: element.style.fontSize, fontFamily: element.style.fontFamily, color: element.style.color,
    align: element.props.align, rotation: element.rotation,
    onCommit(text) {
      const current = board.read(id)
      if (current && (current.type === 'text' || current.type === 'sticky') && text !== current.props.text) {
        board.update(id, { props: { ...current.props, text } })
        commits++
      }
      close()
      status.textContent = `Committed ${commits} text edit${commits === 1 ? '' : 's'}.`
    },
    onCancel: close,
  })
}
canvas.addEventListener('dblclick', (event) => {
  const rect = canvas.getBoundingClientRect()
  const point = { x: event.clientX - rect.left, y: event.clientY - rect.top }
  const element = board.readAll().reverse().find(e => (e.type === 'text' || e.type === 'sticky') && hitTestElement(e, point))
  if (element) beginEdit(element.id)
})
document.querySelector('#undo')!.addEventListener('click', () => board.undoManager.undo())
document.querySelector('#redo')!.addEventListener('click', () => board.undoManager.redo())

function blobDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}
const font = fetch('/fonts/inter-latin-400-normal.woff').then(response => response.arrayBuffer())
  .then(bytes => blobDataUrl(new Blob([bytes], { type: 'font/woff' })))
let japaneseFont: Promise<string> | undefined
async function svg() {
  const elements = board.readAll()
  const fonts = [{ family: 'Inter', dataUrl: await font }]
  if (elements.some(element => (element.type === 'text' || element.type === 'sticky') && /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]/u.test(element.props.text))) {
    japaneseFont ??= fetch('/fonts/noto-sans-jp-400.woff').then(response => response.arrayBuffer())
      .then(bytes => blobDataUrl(new Blob([bytes], { type: 'font/woff' })))
    fonts.push({ family: 'Noto Sans JP', dataUrl: await japaneseFont })
  }
  return documentToSvg(elements, { bounds: fixtureBounds, padding: 0, fonts })
}
async function png(scale = 2) {
  await renderer.whenReady()
  return renderer.exportPng({ bounds: fixtureBounds, scale })
}
function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = name; a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
document.querySelector('#png')!.addEventListener('click', async () => download(await png(), 'whiteboard-spike@2x.png'))
document.querySelector('#svg')!.addEventListener('click', async () => download(new Blob([await svg()], { type: 'image/svg+xml' }), 'whiteboard-spike.svg'))

async function pixels(blob: Blob, scale = 2) {
  if (blob.type === 'image/svg+xml') {
    // Chromium can resolve SVG image.decode() before a large embedded font has
    // loaded. Await the actual data-URL fonts before requesting raster pixels.
    const svgDocument = new DOMParser().parseFromString(await blob.text(), 'image/svg+xml')
    const sheet = new CSSStyleSheet()
    sheet.replaceSync([...svgDocument.querySelectorAll('style')].map(style => style.textContent).join('\n'))
    await Promise.all([...sheet.cssRules].filter((rule): rule is CSSFontFaceRule => rule instanceof CSSFontFaceRule).map(rule =>
      new FontFace(rule.style.getPropertyValue('font-family'), rule.style.getPropertyValue('src'), { weight: rule.style.getPropertyValue('font-weight') || '400' }).load()))
  }
  const image = new Image(), url = URL.createObjectURL(blob)
  try {
    image.src = url
    await image.decode()
    const target = document.createElement('canvas')
    target.width = fixtureBounds.w * scale; target.height = fixtureBounds.h * scale
    const context = target.getContext('2d')!
    context.drawImage(image, 0, 0, target.width, target.height)
    return context.getImageData(0, 0, target.width, target.height).data
  } finally { URL.revokeObjectURL(url) }
}
async function compareExports(svgOverride?: string) {
  const [webgl, vector] = await Promise.all([pixels(await png(2)), pixels(new Blob([svgOverride ?? await svg()], { type: 'image/svg+xml' }))])
  let absoluteError = 0, foreground = 0, mismatched = 0, rawMismatched = 0
  type InkBounds = { left: number; top: number; right: number; bottom: number }
  const regions = [
    { name: 'shapes', x: 20, y: 30, w: 560, h: 200 },
    { name: 'sticky', x: 620, y: 30, w: 250, h: 240 },
    { name: 'text', x: 50, y: 280, w: 520, h: 110 },
    { name: 'stroke', x: 45, y: 390, w: 300, h: 100 },
  ].map(region => ({ ...region, foreground: 0, mismatched: 0, rawMismatched: 0, webglInk: null as InkBounds | null, svgInk: null as InkBounds | null }))
  // SDF and native font rasterizers distribute edge coverage differently. Permit
  // one output pixel (0.5 CSS px at 2×), symmetrically. This alone is not a
  // displacement guarantee: independent ink bounds and negative controls below
  // check placement and missing content separately.
  const width = fixtureBounds.w * 2, height = fixtureBounds.h * 2
  const includeInk = (bounds: InkBounds | null, x: number, y: number): InkBounds => bounds
    ? { left: Math.min(bounds.left, x), top: Math.min(bounds.top, y), right: Math.max(bounds.right, x), bottom: Math.max(bounds.bottom, y) }
    : { left: x, top: y, right: x, bottom: y }
  const nearbyError = (source: Uint8ClampedArray, target: Uint8ClampedArray, index: number) => {
    const x = (index / 4) % width, y = Math.floor(index / 4 / width)
    let best = 255
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (x + dx < 0 || x + dx >= width || y + dy < 0 || y + dy >= height) continue
      const other = ((y + dy) * width + x + dx) * 4
      best = Math.min(best, Math.max(...[0, 1, 2].map(c => Math.abs(source[index + c]! - target[other + c]!))))
    }
    return best
  }
  for (let i = 0; i < webgl.length; i += 4) {
    const error = Math.max(...[0, 1, 2].map(c => Math.abs(webgl[i + c]! - vector[i + c]!)))
    absoluteError += [0, 1, 2].reduce((sum, c) => sum + Math.abs(webgl[i + c]! - vector[i + c]!), 0)
    const painted = [0, 1, 2].some(c => webgl[i + c]! < 245 || vector[i + c]! < 245)
    if (painted) {
      foreground++
      const mismatch = error > 48 && Math.max(nearbyError(webgl, vector, i), nearbyError(vector, webgl, i)) > 48
      if (error > 48) rawMismatched++
      if (mismatch) mismatched++
      const x = ((i / 4) % (fixtureBounds.w * 2)) / 2, y = Math.floor(i / 4 / (fixtureBounds.w * 2)) / 2
      for (const region of regions) if (x >= region.x && x < region.x + region.w && y >= region.y && y < region.y + region.h) {
        region.foreground++
        if (error > 48) region.rawMismatched++
        if (mismatch) region.mismatched++
        // The fixture's text is dark navy; both white/yellow backgrounds and
        // colored shape borders are outside this independent ink mask.
        if (region.name === 'text' || region.name === 'sticky') {
          if (Math.max(webgl[i]!, webgl[i + 1]!, webgl[i + 2]!) < 160) region.webglInk = includeInk(region.webglInk, x * 2, y * 2)
          if (Math.max(vector[i]!, vector[i + 1]!, vector[i + 2]!) < 160) region.svgInk = includeInk(region.svgInk, x * 2, y * 2)
        }
      }
    }
  }
  return {
    meanChannelError: absoluteError / (webgl.length / 4 * 3),
    edgeToleranceCssPixels: 0.5,
    rawForegroundMismatch: rawMismatched / Math.max(1, foreground),
    foregroundMismatch: mismatched / Math.max(1, foreground),
    regions: regions.map(({ name, foreground, mismatched, rawMismatched }) => ({ name, foreground, rawMismatch: rawMismatched / Math.max(1, foreground), mismatch: mismatched / Math.max(1, foreground) })),
    textInkBounds: regions.filter(region => region.name === 'text' || region.name === 'sticky').map(({ name, webglInk, svgInk }) => {
      const maxEdgeDifferencePixels = webglInk && svgInk ? Math.max(...(['left', 'top', 'right', 'bottom'] as const).map(edge => Math.abs(webglInk[edge] - svgInk[edge]))) : null
      return { name, webgl: webglInk, svg: svgInk, maxEdgeDifferencePixels, matches: maxEdgeDifferencePixels !== null && maxEdgeDifferencePixels <= 1 }
    }),
    inkMaskMaxChannel: 160,
    inkBoundsToleranceOutputPixels: 1,
  }
}

let frame = 0
function render() { renderer.render(); frame = requestAnimationFrame(render) }
render()
const ready = renderer.whenReady().then(async () => {
  await document.fonts.ready
  status.textContent = 'Ready. Double-click text to edit.'
})
const api = {
  ready, beginEdit, board, renderer, svg, png: async (scale = 2) => blobDataUrl(await png(scale)), compareExports,
  get commits() { return commits },
  get editingId() { return editingId },
  reload() { activeEditor?.cancel(); renderer.setElements(board.readAll()) },
}
declare global { interface Window { textSpike: typeof api } }
window.textSpike = api
window.addEventListener('pagehide', () => { cancelAnimationFrame(frame); unsubscribe(); renderer.dispose(); board.destroy() }, { once: true })
