import * as Y from 'yjs';

export class UpdateResourceError extends Error {
  constructor(readonly reason: 'invalid-document-update' | 'update-too-large', message: string) { super(message); }
}

/** A bounded v1 resource walk; Yjs remains responsible for decoding and integration. */
export function checkUpdateResources(update: Uint8Array, live: Y.Doc, maxClockGrowth = 1_000_000): boolean {
  let position = 0, structs = 0, values = 0, growth = 0, novelDeletion = false;
  const known = Y.decodeStateVector(Y.encodeStateVector(live));
  const references: { client: number; clock: number }[] = [];
  const invalid = (message: string): never => { throw new UpdateResourceError('invalid-document-update', message); };
  const large = (): never => { throw new UpdateResourceError('update-too-large', 'Update has too many records, values, or nested levels'); };
  const byte = () => { if (position >= update.length) invalid('Truncated update'); return update[position++]!; };
  const uint = () => {
    let value = 0, factor = 1;
    for (let index = 0; index < 8; index++) {
      const next = byte(); value += (next & 127) * factor;
      if (!Number.isSafeInteger(value)) invalid('Unsafe update integer');
      if (!(next & 128)) return value;
      factor *= 128;
    }
    return invalid('Oversized update integer');
  };
  const skip = (length: number) => { if (length > update.length - position) invalid('Truncated content'); position += length; };
  const bytes = () => { const length = uint(), start = position; skip(length); return update.subarray(start, position); };
  const json = () => {
    let depth = 0, quoted = false, escaped = false;
    for (const character of bytes()) {
      if (quoted) { if (escaped) escaped = false; else if (character === 92) escaped = true; else if (character === 34) quoted = false; }
      else if (character === 34) quoted = true;
      else if (character === 123 || character === 91) { if (++depth > 32 || ++values > 200_000) large(); }
      else if (character === 125 || character === 93) depth--;
      else if (character === 44 && ++values > 200_000) large();
    }
  };
  const id = () => { references.push({ client: uint(), clock: uint() }); };
  const any = (depth = 0): void => {
    if (++values > 200_000 || depth > 32) large();
    switch (byte()) {
      case 127: case 126: case 121: case 120: return;
      case 125: { for (let index = 0; index < 8; index++) if (!(byte() & 128)) return; return invalid('Oversized integer content'); }
      case 124: skip(4); return;
      case 123: case 122: skip(8); return;
      case 119: case 116: bytes(); return;
      case 118: { const count = uint(); if (depth >= 32 || count > 200_000 - values) large(); for (let index = 0; index < count; index++) { bytes(); any(depth + 1); } return; }
      case 117: { const count = uint(); if (depth >= 32 || count > 200_000 - values) large(); for (let index = 0; index < count; index++) any(depth + 1); return; }
      default: invalid('Unsupported content encoding');
    }
  };
  const clients = uint(); if (clients > 20_000) large();
  for (let group = 0; group < clients; group++) {
    const count = uint(); if ((structs += count) > 20_000) large();
    const client = uint(); let clock = uint();
    for (let index = 0; index < count; index++) {
      const info = byte(), ref = info & 31;
      let length: number;
      if (info === 10 || ref === 0) length = uint();
      else {
        if (info & 128) id();
        if (info & 64) id();
        if (!(info & 192)) { if (uint()) bytes(); else id(); if (info & 32) bytes(); }
        switch (ref) {
          case 1: length = uint(); break;
          case 2: { length = uint(); if (length > 200_000 - values) large(); values += length; for (let item = 0; item < length; item++) json(); break; }
          case 3: bytes(); length = 1; break;
          case 4: length = new TextDecoder().decode(bytes()).length; break;
          case 5: json(); length = 1; break;
          case 6: bytes(); json(); length = 1; break;
          case 7: { const type = uint(); if (type > 6) invalid('Unsupported shared type'); if (type === 3 || type === 5) bytes(); length = 1; break; }
          case 8: { length = uint(); if (length > 200_000 - values) large(); for (let item = 0; item < length; item++) any(); break; }
          // The whiteboard protocol has no nested Y.Doc ownership or lifecycle.
          case 9: invalid('Subdocuments are not supported');
          default: invalid('Unsupported struct encoding');
        }
      }
      const end = clock + length!, previous = known.get(client) ?? 0;
      if (!length! || !Number.isSafeInteger(end)) invalid('Unsafe struct range');
      if (info === 10 && end > previous && end - Math.max(previous, clock) > maxClockGrowth) invalid('Unbounded skipped struct range');
      if (clock > previous && clock - previous > maxClockGrowth) invalid('Unbounded pending struct gap');
      if (info !== 10 && end > previous) {
        growth += end - Math.max(previous, clock);
        if (growth > maxClockGrowth) invalid('Unbounded logical clock growth');
        known.set(client, end);
      }
      clock = end;
    }
  }
  for (const reference of references) {
    if (!Number.isSafeInteger(reference.clock + 1) || reference.clock + 1 > (known.get(reference.client) ?? 0) + maxClockGrowth) invalid('Unbounded struct reference');
  }
  const deleteClients = uint(); if (deleteClients > 20_000) large();
  let ranges = 0;
  for (let group = 0; group < deleteClients; group++) {
    const client = uint(), count = uint(); if ((ranges += count) > 20_000) large();
    for (let index = 0; index < count; index++) {
      const clock = uint(), length = uint(), end = clock + length;
      if (!length || !Number.isSafeInteger(end) || end > (known.get(client) ?? 0) + maxClockGrowth) invalid('Unbounded pending deletion');
      const existing = live.store.clients.get(client), liveEnd = existing?.length ? existing.at(-1)!.id.clock + existing.at(-1)!.length : 0;
      if (!existing || end > liveEnd) novelDeletion = true;
      else {
        for (let item = Y.findIndexSS(existing, clock); item < existing.length && existing[item]!.id.clock < end; item++) {
          if (!existing[item]!.deleted) { novelDeletion = true; break; }
        }
      }
    }
  }
  if (position !== update.length) invalid('Trailing update content');
  return growth > 0 || novelDeletion;
}
