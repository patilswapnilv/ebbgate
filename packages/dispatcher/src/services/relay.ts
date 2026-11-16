import type { RunnerResult } from "./runner.js";

/** Statuses that must not carry a body (the Fetch spec throws if one is given). */
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

/** Turn a runner's response into the response Ebbgate returns to Paperclip. */
export function relayResponse(result: RunnerResult): Response {
  const headers = {
    "content-type": result.headers.get("content-type") ?? "application/json",
  };
  if (NULL_BODY_STATUSES.has(result.status)) {
    return new Response(null, { status: result.status, headers });
  }
  return new Response(result.body, { status: result.status, headers });
}
