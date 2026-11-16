export interface OllamaSnapshot {
  modelsLoaded: string[];
  modelsInstalled: string[];
}

/** Best-effort Ollama probe; never throws — empty lists if down. */
export async function probeOllama(
  baseUrl: string,
  fetchFn: typeof fetch = fetch,
): Promise<OllamaSnapshot> {
  const modelsLoaded: string[] = [];
  const modelsInstalled: string[] = [];

  try {
    const ps = await fetchFn(`${baseUrl}/api/ps`, { signal: AbortSignal.timeout(2000) });
    if (ps.ok) {
      const body = (await ps.json()) as { models?: Array<{ name?: string; model?: string }> };
      for (const m of body.models ?? []) {
        const name = m.name ?? m.model;
        if (typeof name === "string" && name) modelsLoaded.push(name);
      }
    }
  } catch {
    // Ollama down is fine
  }

  try {
    const tags = await fetchFn(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(2000) });
    if (tags.ok) {
      const body = (await tags.json()) as { models?: Array<{ name?: string }> };
      for (const m of body.models ?? []) {
        if (typeof m.name === "string" && m.name) modelsInstalled.push(m.name);
      }
    }
  } catch {
    // Ollama down is fine
  }

  return { modelsLoaded, modelsInstalled };
}
