export interface PaperclipAgentSummary {
  id: string;
  name?: string;
}

/**
 * Best-effort list of company agents.
 * TODO(verify-paperclip): confirm list path / response shape across versions.
 * Tries GET /api/companies/{companyId}/agents then falls back to empty.
 */
export async function listPaperclipAgents(
  apiUrl: string,
  apiKey: string,
  companyId: string,
  fetchFn: typeof fetch = fetch,
): Promise<PaperclipAgentSummary[]> {
  const base = apiUrl.replace(/\/$/, "");
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
  };

  try {
    const res = await fetchFn(`${base}/api/companies/${encodeURIComponent(companyId)}/agents`, {
      headers,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [];
    const body = (await res.json()) as unknown;
    return normalizeAgents(body);
  } catch {
    return [];
  }
}

function normalizeAgents(body: unknown): PaperclipAgentSummary[] {
  const arr = Array.isArray(body)
    ? body
    : body !== null &&
        typeof body === "object" &&
        Array.isArray((body as { agents?: unknown }).agents)
      ? (body as { agents: unknown[] }).agents
      : [];

  const out: PaperclipAgentSummary[] = [];
  for (const item of arr) {
    if (item === null || typeof item !== "object") continue;
    const id = (item as { id?: unknown }).id;
    if (typeof id !== "string" || !id) continue;
    const name = (item as { name?: unknown }).name;
    out.push({
      id,
      ...(typeof name === "string" ? { name } : {}),
    });
  }
  return out;
}
