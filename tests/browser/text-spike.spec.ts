import { expect, test, type Page } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const pageErrors = new WeakMap<Page, string[]>()
const testEvidence: { title: string; status: string; pageErrors: string[] }[] = []
let browserVersion = ''

test.beforeEach(async ({ page }) => {
  const errors: string[] = []
  pageErrors.set(page, errors)
  page.on('pageerror', error => errors.push(error.message))
  browserVersion = page.context().browser()?.version() ?? ''
  await page.goto('/text/')
  await page.waitForFunction(() => Boolean(window.textSpike), { timeout: 20_000 })
  await page.evaluate(() => window.textSpike.ready)
})

test.afterEach(async ({ page }, testInfo) => {
  const errors = pageErrors.get(page) ?? []
  testEvidence.push({ title: testInfo.title, status: testInfo.status ?? 'unknown', pageErrors: [...errors] })
  expect(errors, 'No uncaught browser errors').toEqual([])
})

test.afterAll(() => {
  if (process.env.RECORD_SPIKE_RESULTS === '1') {
    mkdirSync(resolve('docs/benchmarks/s4'), { recursive: true })
    writeFileSync(resolve('docs/benchmarks/s4/suite-results.json'), JSON.stringify({ timestamp: new Date().toISOString(), browserVersion,
      productionBundle: true, tests: testEvidence, passed: testEvidence.every(result => result.status === 'passed' && result.pageErrors.length === 0) }, null, 2) + '\n')
  }
})

test('native caret, selection, typing and blur form one undo step', async ({ page }) => {
  await page.evaluate(() => window.textSpike.beginEdit('editable'))
  const editor = page.getByRole('textbox', { name: 'Edit text' })
  await expect(editor).toBeFocused()
  await page.keyboard.type('A new idea')
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.insertText('shared ')
  await page.getByRole('heading').click()
  expect(await page.evaluate(() => window.textSpike.commits)).toBe(1)
  expect(await page.evaluate(() => window.textSpike.board.undoManager.undoStack.length)).toBe(1)
  const edited = await page.evaluate(() => window.textSpike.board.read('editable'))
  expect(edited?.props).toMatchObject({ text: 'A new idshared ea' })
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  expect(await page.evaluate(() => window.textSpike.board.read('editable')?.props)).toMatchObject({ text: 'A shared place to think' })
  await page.getByRole('button', { name: 'Redo', exact: true }).click()
  expect(await page.evaluate(() => window.textSpike.board.read('editable')?.props)).toMatchObject({ text: 'A new idshared ea' })
})

test('composition survives blur, commits once, and can be undone', async ({ page }) => {
  await page.evaluate(() => window.textSpike.beginEdit('editable'))
  const editor = page.getByRole('textbox', { name: 'Edit text' })
  await editor.dispatchEvent('compositionstart', { data: '' })
  await editor.evaluate(element => { element.textContent = '日本語のアイデア' })
  await editor.dispatchEvent('compositionupdate', { data: '日本語のアイデア' })
  await page.getByRole('heading').click()
  expect(await page.evaluate(() => window.textSpike.commits)).toBe(0)
  await editor.dispatchEvent('compositionend', { data: '日本語のアイデア' })
  await expect(editor).toHaveCount(0)
  expect(await page.evaluate(() => window.textSpike.board.read('editable')?.props)).toMatchObject({ text: '日本語のアイデア' })
  expect(await page.evaluate(() => window.textSpike.board.undoManager.undoStack.length)).toBe(1)
})

test('Chromium IME candidate input commits through the native editing pipeline', async ({ page, context }, testInfo) => {
  const externalRequests: string[] = []
  await page.route('**/*', async route => {
    const url = new URL(route.request().url())
    if (url.protocol.startsWith('http') && url.hostname !== '127.0.0.1') {
      externalRequests.push(url.href)
      await route.abort()
    } else await route.continue()
  })
  await page.evaluate(() => window.textSpike.beginEdit('editable'))
  const session = await context.newCDPSession(page)
  await session.send('Input.imeSetComposition', { text: 'にほん', selectionStart: 3, selectionEnd: 3 })
  expect(await page.evaluate(() => window.textSpike.commits)).toBe(0)
  await expect(page.getByRole('textbox')).toHaveText('にほん')
  await session.send('Input.imeSetComposition', { text: '日本語', selectionStart: 3, selectionEnd: 3 })
  await session.send('Input.insertText', { text: '日本語' })
  await page.getByRole('heading').click()
  expect(await page.evaluate(() => window.textSpike.board.read('editable')?.props)).toMatchObject({ text: '日本語' })
  expect(await page.evaluate(() => window.textSpike.board.undoManager.undoStack.length)).toBe(1)
  await page.evaluate(() => window.textSpike.renderer.whenReady())
  expect(await page.evaluate(() => window.textSpike.renderer.getTextObject('editable')?.visible)).toBe(true)
  expect(await page.evaluate(() => window.textSpike.renderer.stats().pendingTexts)).toBe(0)
  const glyphs = await page.evaluate(() => ({
    text: window.textSpike.renderer.getTextObject('editable')?.text,
    count: window.textSpike.renderer.getTextObject('editable')?.textRenderInfo?.glyphAtlasIndices.length,
    errors: window.textSpike.renderer.stats().textErrors,
  }))
  expect(glyphs).toEqual({ text: '日本語', count: 3, errors: 0 })
  const exported = await page.evaluate(() => window.textSpike.png())
  expect(exported).toMatch(/^data:image\/png;base64,/)
  const svg = await page.evaluate(() => window.textSpike.svg())
  expect(svg).toContain('Noto Sans JP')
  expect(svg.match(/data:font\/woff;base64,/g)).toHaveLength(2)
  const comparison = await page.evaluate(() => window.textSpike.compareExports())
  expect(comparison.regions.find(region => region.name === 'text')!.mismatch).toBeLessThan(0.18)
  expect(comparison.textInkBounds.find(region => region.name === 'text')!.matches).toBe(true)
  expect(externalRequests).toEqual([])
  const proof = { glyphs, externalRequests, embeddedFonts: 2, pngExported: true, comparison }
  await testInfo.attach('japanese-offline.json', { body: JSON.stringify(proof, null, 2), contentType: 'application/json' })
  if (process.env.RECORD_SPIKE_RESULTS === '1') {
    const raster = await page.evaluate(async value => {
      const image = new Image(), url = URL.createObjectURL(new Blob([value], { type: 'image/svg+xml' }))
      try {
        image.src = url; await image.decode()
        const canvas = document.createElement('canvas'); canvas.width = 1800; canvas.height = 1120
        canvas.getContext('2d')!.drawImage(image, 0, 0, 1800, 1120)
        return canvas.toDataURL()
      } finally { URL.revokeObjectURL(url) }
    }, svg)
    mkdirSync(resolve('docs/benchmarks/s4'), { recursive: true })
    writeFileSync(resolve('docs/benchmarks/s4/japanese-offline.json'), JSON.stringify(proof, null, 2) + '\n')
    writeFileSync(resolve('docs/benchmarks/s4/japanese-offline@2x.png'), Buffer.from(exported.split(',')[1]!, 'base64'))
    writeFileSync(resolve('docs/benchmarks/s4/japanese-offline.svg'), svg)
    writeFileSync(resolve('docs/benchmarks/s4/japanese-svg-raster@2x.png'), Buffer.from(raster.split(',')[1]!, 'base64'))
  }
  await session.detach()
})

test('synced troika text exposes caret positions and selection rectangles', async ({ page }) => {
  const result = await page.evaluate(() => ({
    caret: window.textSpike.renderer.getTextCaret('editable', { x: 100, y: 313 }),
    rects: window.textSpike.renderer.getTextSelectionRects('editable', 2, 8),
  }))
  expect(result.caret).not.toBeNull()
  expect(result.caret?.charIndex).toBeGreaterThanOrEqual(0)
  expect(result.rects.length).toBeGreaterThan(0)
})

test('escape discards the editor draft without a document mutation', async ({ page }) => {
  await page.evaluate(() => window.textSpike.beginEdit('sticky'))
  await page.keyboard.type('Discard this draft')
  await page.keyboard.press('Escape')
  expect(await page.evaluate(() => window.textSpike.commits)).toBe(0)
  expect(await page.evaluate(() => window.textSpike.board.undoManager.undoStack.length)).toBe(0)
  expect(await page.evaluate(() => window.textSpike.board.read('sticky')?.props)).toMatchObject({ text: 'Ideas take shape' })
})

test('native cut and paste preserve text, and commit once', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.evaluate(() => window.textSpike.beginEdit('editable'))
  await page.keyboard.type('Clipboard idea')
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.press('ControlOrMeta+X')
  await expect(page.getByRole('textbox')).toHaveText('')
  await page.keyboard.press('ControlOrMeta+V')
  await expect(page.getByRole('textbox')).toHaveText('Clipboard idea')
  await page.getByRole('heading').click()
  expect(await page.evaluate(() => window.textSpike.commits)).toBe(1)
})

test('mixed board exports at 2× with SVG visual parity per region', async ({ page }, testInfo) => {
  const png = await page.evaluate(() => window.textSpike.png(2))
  const svg = await page.evaluate(() => window.textSpike.svg())
  const svgPng = await page.evaluate(async svg => {
    const image = new Image(), url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
    image.src = url
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = 1800; canvas.height = 1120
    canvas.getContext('2d')!.drawImage(image, 0, 0, canvas.width, canvas.height)
    URL.revokeObjectURL(url)
    return canvas.toDataURL()
  }, svg)
  await testInfo.attach('mixed-board@2x.png', { body: Buffer.from(png.split(',')[1]!, 'base64'), contentType: 'image/png' })
  await testInfo.attach('svg-raster@2x.png', { body: Buffer.from(svgPng.split(',')[1]!, 'base64'), contentType: 'image/png' })
  await testInfo.attach('mixed-board.svg', { body: svg, contentType: 'image/svg+xml' })
  const dimensions = await page.evaluate(async png => { const image = new Image(); image.src = png; await image.decode(); return [image.width, image.height] }, png)
  expect(dimensions).toEqual([1800, 1120])
  expect(svg).toContain('data:font/woff;base64,')
  const comparison = await page.evaluate(() => window.textSpike.compareExports())
  await testInfo.attach('comparison.json', { body: JSON.stringify(comparison, null, 2), contentType: 'application/json' })
  if (process.env.RECORD_SPIKE_RESULTS === '1') {
    const directory = resolve('docs/benchmarks/s4')
    mkdirSync(directory, { recursive: true })
    writeFileSync(resolve(directory, 'mixed-board@2x.png'), Buffer.from(png.split(',')[1]!, 'base64'))
    writeFileSync(resolve(directory, 'svg-raster@2x.png'), Buffer.from(svgPng.split(',')[1]!, 'base64'))
    writeFileSync(resolve(directory, 'mixed-board.svg'), svg)
    writeFileSync(resolve(directory, 'comparison.json'), JSON.stringify(comparison, null, 2) + '\n')
    await page.screenshot({ path: resolve(directory, 'prototype.png') })
  }
  expect(comparison.meanChannelError).toBeLessThan(5)
  for (const region of comparison.regions) {
    expect(region.foreground, region.name).toBeGreaterThan(100)
    if (region.name !== 'text') expect(region.rawMismatch, `${region.name}: direct pixel comparison`).toBeLessThan(0.18)
    expect(region.mismatch, region.name).toBeLessThan(0.18)
  }
  for (const bounds of comparison.textInkBounds) {
    expect(bounds.webgl, `${bounds.name}: PNG ink present`).not.toBeNull()
    expect(bounds.svg, `${bounds.name}: SVG ink present`).not.toBeNull()
    expect(bounds.maxEdgeDifferencePixels, `${bounds.name}: independent ink bounds`).toBeLessThanOrEqual(1)
  }
})

test('visual comparison rejects missing and displaced text despite edge tolerance', async ({ page }, testInfo) => {
  const controls = await page.evaluate(async () => {
    const svg = await window.textSpike.svg()
    const parser = new DOMParser(), serializer = new XMLSerializer()
    const missing = parser.parseFromString(svg, 'image/svg+xml')
    missing.querySelector('[data-element-id="editable"]')!.remove()
    const shiftedOne = parser.parseFromString(svg, 'image/svg+xml')
    shiftedOne.querySelector('[data-element-id="editable"]')!.setAttribute('transform', 'translate(1 0)')
    const shiftedEight = parser.parseFromString(svg, 'image/svg+xml')
    shiftedEight.querySelector('[data-element-id="editable"]')!.setAttribute('transform', 'translate(8 0)')
    return [
      { name: 'missing', comparison: await window.textSpike.compareExports(serializer.serializeToString(missing)) },
      { name: 'shift-1-css-pixel', comparison: await window.textSpike.compareExports(serializer.serializeToString(shiftedOne)) },
      { name: 'shift-8-css-pixels', comparison: await window.textSpike.compareExports(serializer.serializeToString(shiftedEight)) },
    ]
  })
  await testInfo.attach('negative-controls.json', { body: JSON.stringify(controls, null, 2), contentType: 'application/json' })
  if (process.env.RECORD_SPIKE_RESULTS === '1') {
    mkdirSync(resolve('docs/benchmarks/s4'), { recursive: true })
    writeFileSync(resolve('docs/benchmarks/s4/negative-controls.json'), JSON.stringify(controls, null, 2) + '\n')
  }
  for (const { name, comparison } of controls) {
    const bounds = comparison.textInkBounds.find(region => region.name === 'text')!
    expect(bounds.matches, `${name}: independent ink bounds reject`).toBe(false)
    if (name !== 'shift-1-css-pixel') expect(comparison.regions.find(region => region.name === 'text')!.mismatch, name).toBeGreaterThan(0.18)
  }
})
