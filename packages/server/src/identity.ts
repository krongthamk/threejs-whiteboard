/** Canonical external identity address; password usernames remain exact and case-sensitive. */
export function normalizeExternalEmail(value: unknown): string {
  if (typeof value !== 'string' || value.length > 254 || !/^[\x21-\x7e]+$/.test(value)) throw new Error('Invalid external email');
  const parts = value.split('@'), local = parts[0], domain = parts[1];
  if (parts.length !== 2 || !local || !domain || local.length > 64 ||
    !/^[a-zA-Z0-9!#$%&'*+\-/=?^_`{|}~]+(?:\.[a-zA-Z0-9!#$%&'*+\-/=?^_`{|}~]+)*$/.test(local) ||
    domain.split('.').some(label => !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label))) throw new Error('Invalid external email');
  return value.toLowerCase();
}

const segments = new Intl.Segmenter('und', { granularity: 'grapheme' });
/** Preserve source spelling while fitting the existing awareness UTF16 bound. */
export function displayName(value: unknown, fallback: string): string {
  if (value !== null && value !== undefined && typeof value !== 'string') throw new Error('Invalid display name');
  if (typeof value === 'string' && /[\uD800-\uDFFF\p{Cc}]/u.test(value)) throw new Error('Invalid display name');
  const source = typeof value === 'string' && value.trim() ? value : fallback;
  if (!source || /[\uD800-\uDFFF\p{Cc}]/u.test(source)) throw new Error('Invalid display name');
  let name = '';
  for (const { segment } of segments.segment(source)) {
    if (name.length + segment.length > 80) break;
    name += segment;
  }
  // A single pathological combining cluster can exceed the whole wire bound.
  if (!name && source !== fallback) return displayName(null, fallback);
  if (!name) throw new Error('Display name cannot fit awareness limit');
  return name;
}
