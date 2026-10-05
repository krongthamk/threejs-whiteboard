import { afterEach, expect, it, vi } from 'vitest';
import { MAX_EXCALIDRAW_BYTES } from '@whiteboard/model';
import { parseExcalidrawSource } from './excalidraw-import';

afterEach(() => vi.restoreAllMocks());

it('accepts exactly 50 MiB of original JSON whitespace bytes and rejects one more byte before parsing', () => {
  const json = '{"type":"excalidraw","version":2,"elements":[]}';
  // Every character is ASCII, including the original trailing whitespace.
  const original = json + ' '.repeat(MAX_EXCALIDRAW_BYTES - json.length);
  expect(original.length).toBe(MAX_EXCALIDRAW_BYTES);
  const parse = vi.spyOn(JSON, 'parse');
  expect(parseExcalidrawSource(original, MAX_EXCALIDRAW_BYTES)).toEqual({ type: 'excalidraw', version: 2, elements: [] });
  expect(parse).toHaveBeenCalledTimes(1); parse.mockClear();
  expect(() => parseExcalidrawSource(original + ' ', MAX_EXCALIDRAW_BYTES + 1)).toThrow('50 MiB');
  expect(parse).not.toHaveBeenCalled();
});

it('rejects original multibyte JSON below the UTF16 cap but above the UTF8 cap before JSON.parse', () => {
  const original = '{"type":"excalidraw","version":2,"elements":[],"metadata":"' + '日'.repeat(Math.floor(MAX_EXCALIDRAW_BYTES / 3)) + '"}';
  expect(original.length).toBeLessThan(MAX_EXCALIDRAW_BYTES);
  expect(new TextEncoder().encode(original).length).toBeGreaterThan(MAX_EXCALIDRAW_BYTES);
  const parse = vi.spyOn(JSON, 'parse');
  // No caller-supplied byte count: this must take the actual UTF8 guard branch.
  expect(() => parseExcalidrawSource(original)).toThrow('50 MiB');
  expect(parse).not.toHaveBeenCalled();
});
