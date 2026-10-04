import { assertSafeImageDimensions, MAX_IMAGE_BYTES, type ImageHeader } from '@whiteboard/model';
import { waitForSignal } from '@whiteboard/renderer';

/** Bake validated EXIF transforms into pixels so every export consumer sees the same image. */
export async function normalizeImageOrientation(blob: Blob, header: ImageHeader, signal?: AbortSignal): Promise<Blob> {
  signal?.throwIfAborted();
  if (!header.orientation) return blob;
  assertSafeImageDimensions(header.width, header.height);
  const canvas = document.createElement('canvas');
  canvas.width = header.width; canvas.height = header.height;
  let bitmap: ImageBitmap | undefined, image: HTMLImageElement | undefined, url: string | undefined;
  try {
    let source: CanvasImageSource, width: number, height: number;
    if (typeof createImageBitmap === 'function') {
      const decoded = await waitForSignal<ImageBitmap>(createImageBitmap(blob).then(decoded => {
        if (signal?.aborted) { decoded.close(); signal.throwIfAborted(); }
        return decoded;
      }), signal);
      bitmap = decoded; source = decoded; width = decoded.width; height = decoded.height;
    } else {
      image = new Image(); url = URL.createObjectURL(blob); image.src = url;
      await waitForSignal(image.decode(), signal);
      source = image; width = image.naturalWidth; height = image.naturalHeight;
    }
    if (width !== header.width || height !== header.height) throw new Error('The image has inconsistent encoded dimensions.');
    const context = canvas.getContext('2d');
    if (!context) throw new Error('The image could not be normalized.');
    context.drawImage(source, 0, 0);
    const result = await waitForSignal(new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('The image could not be normalized.')), 'image/png')), signal);
    if (result.size > MAX_IMAGE_BYTES) throw new Error('The normalized image exceeds the 20 MiB limit.');
    return result;
  } finally {
    bitmap?.close(); if (image) image.src = ''; if (url) URL.revokeObjectURL(url);
    canvas.width = canvas.height = 0;
  }
}
