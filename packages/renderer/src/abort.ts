/** Cancel a consumer without cancelling unrelated producers such as the shared glyph atlas. */
export function waitForSignal<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => { if (settled) return; settled = true; signal.removeEventListener('abort', aborted); callback(); };
    const aborted = () => finish(() => reject(signal.reason ?? new DOMException('The export was cancelled.', 'AbortError')));
    signal.addEventListener('abort', aborted, { once: true });
    work.then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
    if (signal.aborted) aborted();
  });
}
