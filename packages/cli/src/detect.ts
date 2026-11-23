export interface DetectedServices {
  ollama: string | null;
  litellm: string | null;
  paperclip: string | null;
}

const DEFAULTS = {
  ollama: "http://127.0.0.1:11434",
  litellm: "http://127.0.0.1:4000",
  paperclip: "http://127.0.0.1:3100",
} as const;

/** Probe common local ports. Returns the base URL when the service answers. */
export async function detectServices(
  fetchFn: typeof fetch = fetch,
  timeoutMs = 800,
): Promise<DetectedServices> {
  const [ollama, litellm, paperclip] = await Promise.all([
    probe(DEFAULTS.ollama, "/api/tags", fetchFn, timeoutMs),
    probe(DEFAULTS.litellm, "/health", fetchFn, timeoutMs),
    probe(DEFAULTS.paperclip, "/api/health", fetchFn, timeoutMs),
  ]);
  return { ollama, litellm, paperclip };
}

export { DEFAULTS as DETECT_DEFAULTS };

async function probe(
  base: string,
  path: string,
  fetchFn: typeof fetch,
  timeoutMs: number,
): Promise<string | null> {
  try {
    const res = await fetchFn(`${base}${path}`, {
      method: "GET",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok || res.status < 500 ? base : null;
  } catch {
    return null;
  }
}
