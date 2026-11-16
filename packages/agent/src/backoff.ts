/** Exponential backoff with jitter. Caps at maxMs. */
export function nextBackoffMs(attempt: number, baseMs = 1000, maxMs = 60_000): number {
  const exp = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt));
  const jitter = Math.floor(Math.random() * Math.min(1000, exp * 0.1));
  return Math.min(maxMs, exp + jitter);
}
