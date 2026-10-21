try {
  const response = await fetch('http://127.0.0.1:3001/ready', { signal: AbortSignal.timeout(5000) });
  if (!response.ok || (await response.json()).ready !== true) process.exitCode = 1;
} catch { process.exitCode = 1; }
