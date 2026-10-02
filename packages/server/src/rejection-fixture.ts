// Exercise the production entry point's last-resort rejection handler in isolation.
export {};
await import('./index.js');
process.on('message', (message: { type: string }) => {
  if (message.type === 'reject') {
    void Promise.reject(new Error('Injected unhandled rejection'));
    process.disconnect?.();
  }
});
