import { assertSafeImageDimensions, MAX_IMAGE_BYTES, type ImageHeader, type ExcalidrawImageTransform } from '@whiteboard/model';
import { waitForSignal } from '@whiteboard/renderer';

/** Bake validated EXIF transforms into pixels so every export consumer sees the same image. */
export async function normalizeImageOrientation(blob: Blob, header: ImageHeader, signal?: AbortSignal): Promise<Blob> {
  signal?.throwIfAborted();
  return header.orientation ? normalizeImagePixels(blob, header, signal) : blob;
}

/** Convert browser display pixels to an 8-bit PNG for consumers with narrower PNG support. */
export async function normalizeImagePixels(blob: Blob, header: Pick<ImageHeader, 'width' | 'height'>, signal?: AbortSignal, transform?: ExcalidrawImageTransform): Promise<Blob> {
  signal?.throwIfAborted();
  assertSafeImageDimensions(header.width, header.height);
  const canvas = document.createElement('canvas');
  const crop = transform?.crop;
  if (crop && (![crop.x, crop.y, crop.width, crop.height].every(Number.isFinite) || crop.x < 0 || crop.y < 0 || crop.width <= 0 || crop.height <= 0 || crop.x + crop.width > header.width || crop.y + crop.height > header.height)) throw new Error('The image crop is outside its decoded dimensions.');
  const outputWidth = crop ? Math.max(1, Math.ceil(crop.width)) : header.width;
  const outputHeight = crop ? Math.max(1, Math.ceil(crop.height)) : header.height;
  assertSafeImageDimensions(outputWidth, outputHeight);
  canvas.width = outputWidth; canvas.height = outputHeight;
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
    // Browser decoding applies EXIF first. Crop that oriented source, then mirror the result.
    if (transform?.flipX || transform?.flipY) {
      context.translate(transform.flipX ? outputWidth : 0, transform.flipY ? outputHeight : 0);
      context.scale(transform.flipX ? -1 : 1, transform.flipY ? -1 : 1);
    }
    if (crop) context.drawImage(source, crop.x, crop.y, crop.width, crop.height, 0, 0, outputWidth, outputHeight);
    else context.drawImage(source, 0, 0);
    const result = await waitForSignal(new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('The image could not be normalized.')), 'image/png')), signal);
    if (result.size > MAX_IMAGE_BYTES) throw new Error('The normalized image exceeds the 20 MiB limit.');
    return result;
  } finally {
    bitmap?.close(); if (image) image.src = ''; if (url) URL.revokeObjectURL(url);
    canvas.width = canvas.height = 0;
  }
}
