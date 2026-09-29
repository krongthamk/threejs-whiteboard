/** Rebuild with: node packages/model/scripts/generate-font-metrics.mjs
 * Build-time only: reuse the pinned renderer parser, so no font parser enters the model bundle.
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const requireRenderer = createRequire(resolve(here, '../../renderer/package.json'));
const parserRoot = dirname(requireRenderer.resolve('troika-three-text/package.json'));
const parserPackage = JSON.parse(await readFile(resolve(parserRoot, 'package.json'), 'utf8'));
globalThis.self = globalThis;
const { default: parser } = await import(pathToFileURL(resolve(parserRoot, 'src/FontParser.js')).href);
const typr = (await import(pathToFileURL(resolve(parserRoot, 'libs/typr.factory.js')).href)).default();
const unpackWoff = (await import(pathToFileURL(resolve(parserRoot, 'libs/woff2otf.factory.js')).href)).default();

/** Only pair tables' nonzero classes and supported ligatures can alter advances.
 * This avoids enumerating the 280 million pairs in the Japanese font's cmap.
 * Candidate adjustments are still measured by the exact pinned Troika parser.
 */
function supportedLigatures(raw, characters) {
  const glyphs = new Map(), sequences = new Set();
  for (const character of characters) {
    const id = typr.U.codeToGlyph(raw, character.codePointAt(0)), aliases = glyphs.get(id) ?? [];
    aliases.push(character); glyphs.set(id, aliases);
  }
  const used = new Set((raw.GSUB?.featureList ?? []).filter(feature => /^(rlig|liga|mset|isol|init|fina|medi|half|pres|blws|ccmp)$/.test(feature.tag)).flatMap(feature => feature.tab));
  for (const index of used) {
    const lookup = raw.GSUB.lookupList[index];
    if (lookup.ltype !== 4) continue;
    for (const table of lookup.tabs) if (table?.coverage) for (const left of glyphs.keys()) {
      const entry = typr._lctf.coverageIndex(table.coverage, left); if (entry < 0) continue;
      for (const ligature of table.vals[entry]) {
        let aliases = [''];
        for (const glyph of [left, ...ligature.chain]) aliases = aliases.flatMap(prefix => (glyphs.get(glyph) ?? []).map(character => prefix + character));
        for (const sequence of aliases) sequences.add(sequence);
      }
    }
  }
  return sequences;
}
function sparsePairs(raw, glyphForToken) {
  const glyphs = new Map(), candidates = new Set();
  for (const [token, glyph] of glyphForToken) {
    const aliases = glyphs.get(glyph) ?? []; aliases.push(token); glyphs.set(glyph, aliases);
  }
  const cover = table => [...glyphs.keys()].filter(glyph => typr._lctf.coverageIndex(table, glyph) !== -1);
  const add = (left, right) => { for (const a of glyphs.get(left) ?? []) for (const b of glyphs.get(right) ?? []) candidates.add(JSON.stringify([a, b])); };
  const advances = value => value?.val1?.[2] || value?.val2?.[2];
  for (const lookup of raw.GPOS?.lookupList ?? []) if (lookup.ltype === 2) for (const table of lookup.tabs) {
    if (table.fmt === 1) for (const left of cover(table.coverage)) {
      for (const pair of table.pairsets[typr._lctf.coverageIndex(table.coverage, left)]) if (advances(pair)) add(left, pair.gid2);
    } else if (table.fmt === 2) {
      const groups = new Map();
      for (const glyph of glyphs.keys()) { const group = typr.U._getGlyphClass(glyph, table.classDef2), entries = groups.get(group) ?? []; entries.push(glyph); groups.set(group, entries); }
      for (const left of cover(table.coverage)) {
        const row = table.matrix[typr.U._getGlyphClass(left, table.classDef1)];
        for (const [group, rights] of groups) if (advances(row[group])) for (const right of rights) add(left, right);
      }
    }
  }
  return [...candidates].map(value => JSON.parse(value));
}
const fonts = {};
for (const [family, filename] of [['Inter', 'inter-latin-400-normal.woff'], ['IBM Plex Mono', 'ibm-plex-mono-latin-400-normal.woff'], ['Noto Sans JP', 'noto-sans-jp-400.woff']]) {
  const bytes = await readFile(resolve(here, '../../app/public/fonts', filename));
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const font = await parser.onMainThread(buffer);
  const advances = {}, pairs = {}, ligatures = {}, terminals = {}, pairTerminals = {}, offsets = {}, pairOffsets = {}, glyphForToken = new Map();
  const measure = text => font.forEachGlyph(text, font.unitsPerEm, 0, () => {});
  for (let point = 32; point <= 0x10ffff; point++) {
    if (point >= 0xd800 && point <= 0xdfff) continue;
    if (font.supportsCodePoint(point)) {
      const character = String.fromCodePoint(point);
      advances[character] = font.forEachGlyph(character, font.unitsPerEm, 0, glyph => glyphForToken.set(character, glyph.index));
    }
  }
  const characters = Object.keys(advances), raw = typr.parse(unpackWoff(buffer))[0];
  for (const sequence of supportedLigatures(raw, characters)) {
    const glyphs = [];
    const width = font.forEachGlyph(sequence, font.unitsPerEm, 0, glyph => glyphs.push(glyph.index));
    if (glyphs.length === 1) { ligatures[sequence] = width; glyphForToken.set(sequence, glyphs[0]); }
  }
  const tokens = [...characters, ...Object.keys(ligatures)];
  const terminal = text => {
    let end = 0;
    const advance = font.forEachGlyph(text, font.unitsPerEm, 0, (glyph, x) => { end = x + glyph.advanceWidth; });
    return end - advance;
  };
  // Troika's Typesetter ends each font run at the last glyph's raw advance,
  // not FontParser's final (GPOS-adjusted) pen. Most glyphs need no correction.
  for (const token of tokens) {
    const value = terminal(token); if (value !== 0) terminals[token] = value;
    font.forEachGlyph(token, font.unitsPerEm, 0, (_glyph, x) => { if (x !== 0) offsets[token] = x; });
  }
  const candidates = family === 'Noto Sans JP' ? sparsePairs(raw, glyphForToken)
    : tokens.flatMap(first => tokens.map(second => [first, second]));
  const advance = token => advances[token] ?? ligatures[token];
  for (const [first, second] of candidates) {
    // A pair that itself forms a ligature will be one token at runtime.
    if (ligatures[first + second] !== undefined) continue;
    const adjustment = measure(first + second) - advance(first) - advance(second);
    if (adjustment !== 0) pairs[first + second] = adjustment;
    const tail = terminal(first + second) - (terminals[second] ?? 0);
    if (tail !== 0) pairTerminals[first + second] = tail;
    let x = 0;
    font.forEachGlyph(first + second, font.unitsPerEm, 0, (_glyph, value) => { x = value; });
    const offset = x - advance(first) - adjustment - (offsets[second] ?? 0);
    if (offset !== 0) pairOffsets[first + second] = offset;
  }
  fonts[family] = {
    file: filename,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    unitsPerEm: font.unitsPerEm, ascender: font.ascender, descender: font.descender, lineGap: font.lineGap,
    advances, pairs, ligatures, terminals, pairTerminals, offsets, pairOffsets,
  };
  console.log(`${family}: ${characters.length} characters, ${Object.keys(pairs).length} adjusted pairs (${candidates.length} candidates), ${Object.keys(ligatures).length} ligatures`);
}
await writeFile(resolve(here, '../src/font-metrics.generated.json'), `${JSON.stringify({ generator: `troika-three-text ${parserPackage.version} FontParser`, fonts })}\n`);
