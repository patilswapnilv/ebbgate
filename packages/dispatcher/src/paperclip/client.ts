import { ParseError, parseRun } from "./parse.js";
import type { PaperclipClient, TaskContextInput } from "./types.js";

export interface HttpPaperclipOptions {
  apiUrl: string;
  apiKey: string;
  /**
   * Fallback company id for label lookups. Normally unnecessary: the issue's own
   * companyId (from GET /api/issues/{id}) is used.
   */
  companyId?: string;
  fetch?: typeof fetch;
  /** Per-request timeout in milliseconds (default 15 s). */
  timeoutMs?: number;
}

/** Default bound for every Paperclip request, so a stalled call cannot hold a drain open. */
export const PAPERCLIP_TIMEOUT_MS = 15_000;

/** Release a response body we do not read, so the connection can be reused. */
async function discard(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // Already consumed or closed: nothing to release.
  }
}

/**
 * Real Paperclip HTTP client.
 *
 * Wake + comment paths are confirmed in docs. Labels use GET /api/issues/{id}
 * (companyId, labelIds), GET/POST /api/companies/{companyId}/labels and
 * PATCH /api/issues/{id} with the full labelIds set.
 */
export function createHttpPaperclipClient(opts: HttpPaperclipOptions): PaperclipClient {
  const fetchFn = opts.fetch ?? fetch;
  const base = opts.apiUrl.replace(/\/$/, "");

  async function api(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${opts.apiKey}`,
      Accept: "application/json",
      ...extraHeaders,
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const init: RequestInit = {
      method,
      headers,
      signal: AbortSignal.timeout(opts.timeoutMs ?? PAPERCLIP_TIMEOUT_MS),
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    return fetchFn(`${base}${path}`, init);
  }

  return {
    parseRun(body: unknown, headers: Headers): TaskContextInput {
      return parseRun(body, headers);
    },

    async wakeAgent(args): Promise<void> {
      // Confirmed: POST /api/agents/{agentId}/wakeup (body shape: fixtures/paperclip/wakeup-request.json)
      const payload: Record<string, unknown> = {
        source: "on_demand",
        triggerDetail: "system",
        reason: args.reason,
        forceFreshSession: false,
      };
      if (args.issueId) payload.payload = { issueId: args.issueId };
      const key =
        args.idempotencyKey ?? (args.issueId ? `ebbgate-defer-${args.issueId}` : undefined);
      if (key) payload.idempotencyKey = key;
      const res = await api(
        "POST",
        `/api/agents/${encodeURIComponent(args.agentId)}/wakeup`,
        payload,
      );
      await discard(res);
      if (!res.ok) {
        throw new Error(`paperclip wakeAgent failed: ${res.status}`);
      }
    },

    async commentOnIssue(issueId, body): Promise<void> {
      // Confirmed: POST /api/issues/{issueId}/comments
      const res = await api("POST", `/api/issues/${encodeURIComponent(issueId)}/comments`, {
        body,
      });
      await discard(res);
      if (!res.ok) {
        throw new Error(`paperclip commentOnIssue failed: ${res.status}`);
      }
    },

    async addLabel(issueId, label): Promise<void> {
      // 1. Read the issue: it carries its own companyId and current labelIds, so no
      //    company id has to be configured. (Issue object: companyId, labelIds.)
      const issue = await getIssue(issueId);
      const companyId = issue.companyId ?? opts.companyId;
      if (!companyId) {
        throw new Error("paperclip addLabel: issue response has no companyId");
      }

      // 2. Resolve (or create) the company label by name.
      const labelId = await resolveLabelId(companyId, label);
      if (issue.labelIds.includes(labelId)) return; // already labelled: nothing to write

      // 3. PATCH replaces the issue's full label set, so send existing + new.
      // TODO(verify-paperclip): Paperclip documents no concurrency check (ETag/If-Match/
      // version) for issue updates. A label change made by someone else between steps 1
      // and 3 could be lost. We re-read and retry once if our label did not stick, which
      // narrows but cannot close that window.
      await patchLabels(issueId, [...issue.labelIds, labelId]);
      const after = await getIssue(issueId);
      if (!after.labelIds.includes(labelId)) {
        await patchLabels(issueId, [...after.labelIds, labelId]);
      }
    },
  };

  async function getIssue(issueId: string): Promise<{ companyId?: string; labelIds: string[] }> {
    const res = await api("GET", `/api/issues/${encodeURIComponent(issueId)}`);
    if (!res.ok) {
      await discard(res);
      throw new Error(`paperclip get issue failed: ${res.status}`);
    }
    const raw = (await res.json()) as unknown;
    const obj = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const labelIds = Array.isArray(obj.labelIds)
      ? obj.labelIds.filter((v): v is string => typeof v === "string")
      : Array.isArray(obj.labels)
        ? obj.labels
            .map((l) =>
              l !== null && typeof l === "object" ? (l as { id?: unknown }).id : undefined,
            )
            .filter((v): v is string => typeof v === "string")
        : [];
    return {
      ...(typeof obj.companyId === "string" ? { companyId: obj.companyId } : {}),
      labelIds,
    };
  }

  async function resolveLabelId(companyId: string, label: string): Promise<string> {
    const listRes = await api("GET", `/api/companies/${encodeURIComponent(companyId)}/labels`);
    if (!listRes.ok) {
      await discard(listRes);
      throw new Error(`paperclip list labels failed: ${listRes.status}`);
    }
    const listed = (await listRes.json()) as unknown;
    const labels = Array.isArray(listed)
      ? listed
      : listed !== null &&
          typeof listed === "object" &&
          Array.isArray((listed as { labels?: unknown }).labels)
        ? (listed as { labels: unknown[] }).labels
        : [];
    for (const item of labels) {
      if (
        item !== null &&
        typeof item === "object" &&
        (item as { name?: unknown }).name === label &&
        typeof (item as { id?: unknown }).id === "string"
      ) {
        return (item as { id: string }).id;
      }
    }
    const createRes = await api("POST", `/api/companies/${encodeURIComponent(companyId)}/labels`, {
      name: label,
      color: "#64748b",
    });
    if (!createRes.ok) {
      await discard(createRes);
      throw new Error(`paperclip create label failed: ${createRes.status}`);
    }
    const created = (await createRes.json()) as { id?: unknown };
    if (typeof created.id !== "string") {
      throw new Error("paperclip create label response missing id");
    }
    return created.id;
  }

  async function patchLabels(issueId: string, labelIds: string[]): Promise<void> {
    const res = await api("PATCH", `/api/issues/${encodeURIComponent(issueId)}`, {
      labelIds: [...new Set(labelIds)],
    });
    await discard(res);
    if (!res.ok) throw new Error(`paperclip addLabel patch failed: ${res.status}`);
  }
}

export type { PaperclipClient, TaskContextInput };
export { ParseError };
