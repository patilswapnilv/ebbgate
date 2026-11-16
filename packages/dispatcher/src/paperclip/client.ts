import { ParseError, parseRun } from "./parse.js";
import type { PaperclipClient, TaskContextInput } from "./types.js";

export interface HttpPaperclipOptions {
  apiUrl: string;
  apiKey: string;
  /** Optional company id used when resolving labels by name. */
  companyId?: string;
  fetch?: typeof fetch;
}

/**
 * Real Paperclip HTTP client.
 *
 * Wake + comment paths are confirmed in docs. Label attach path is assumed
 * and marked TODO(verify-paperclip).
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
    const init: RequestInit = { method, headers };
    if (body !== undefined) init.body = JSON.stringify(body);
    return fetchFn(`${base}${path}`, init);
  }

  return {
    parseRun(body: unknown, headers: Headers): TaskContextInput {
      return parseRun(body, headers);
    },

    async wakeAgent(args): Promise<void> {
      // Confirmed: POST /api/agents/{agentId}/wakeup
      const payload: Record<string, unknown> = {
        source: "on_demand",
        triggerDetail: "system",
        reason: args.reason,
        forceFreshSession: false,
      };
      if (args.issueId) {
        payload.payload = { issueId: args.issueId };
        payload.idempotencyKey = `ebbgate-defer-${args.issueId}`;
      }
      const res = await api(
        "POST",
        `/api/agents/${encodeURIComponent(args.agentId)}/wakeup`,
        payload,
      );
      if (!res.ok && res.status !== 202) {
        throw new Error(`paperclip wakeAgent failed: ${res.status}`);
      }
    },

    async commentOnIssue(issueId, body): Promise<void> {
      // Confirmed: POST /api/issues/{issueId}/comments
      const res = await api("POST", `/api/issues/${encodeURIComponent(issueId)}/comments`, {
        body,
      });
      if (!res.ok) {
        throw new Error(`paperclip commentOnIssue failed: ${res.status}`);
      }
    },

    async addLabel(issueId, label): Promise<void> {
      // TODO(verify-paperclip): exact REST paths for listing/creating company labels.
      // Assumed: GET/POST /api/companies/{companyId}/labels, then PATCH issue with labelIds.
      const companyId = opts.companyId;
      if (!companyId) {
        throw new Error("paperclip addLabel requires companyId");
      }

      const listRes = await api("GET", `/api/companies/${encodeURIComponent(companyId)}/labels`);
      if (!listRes.ok) {
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

      let labelId: string | undefined;
      for (const item of labels) {
        if (
          item !== null &&
          typeof item === "object" &&
          (item as { name?: unknown }).name === label &&
          typeof (item as { id?: unknown }).id === "string"
        ) {
          labelId = (item as { id: string }).id;
          break;
        }
      }

      if (!labelId) {
        const createRes = await api(
          "POST",
          `/api/companies/${encodeURIComponent(companyId)}/labels`,
          { name: label, color: "#64748b" },
        );
        if (!createRes.ok) {
          throw new Error(`paperclip create label failed: ${createRes.status}`);
        }
        const created = (await createRes.json()) as { id?: string };
        if (typeof created.id !== "string") {
          throw new Error("paperclip create label response missing id");
        }
        labelId = created.id;
      }

      // TODO(verify-paperclip): whether PATCH replaces the full label set (merge vs replace).
      const patchRes = await api("PATCH", `/api/issues/${encodeURIComponent(issueId)}`, {
        labelIds: [labelId],
      });
      if (!patchRes.ok) {
        throw new Error(`paperclip addLabel patch failed: ${patchRes.status}`);
      }
    },
  };
}

export type { PaperclipClient, TaskContextInput };
export { ParseError };
