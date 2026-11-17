export interface RunnerResult {
  status: number;
  headers: Headers;
  body: ArrayBuffer;
}

export interface ForwardOptions {
  /** Bound for the whole exchange: connect, headers and reading the body. */
  timeoutMs: number;
  /**
   * Stable key for the logical task, sent as `Idempotency-Key`, so a runner can
   * recognise a re-dispatch of work it may already have received.
   */
  idempotencyKey?: string;
}

/** Forward the original Paperclip payload to a local or cloud runner. */
export async function forwardToRunner(
  runnerUrl: string,
  payload: unknown,
  headers: Headers,
  fetchFn: typeof fetch = fetch,
  opts: ForwardOptions = { timeoutMs: 10 * 60 * 1000 },
): Promise<RunnerResult> {
  const out = new Headers();
  const auth = headers.get("authorization");
  if (auth) out.set("authorization", auth);
  out.set("content-type", "application/json");
  if (opts.idempotencyKey) out.set("idempotency-key", opts.idempotencyKey);
  // TODO(verify-paperclip): which headers runners expect beyond Authorization.

  // One signal covers the request and the body read: a runner that sends headers
  // and then stalls makes arrayBuffer() reject instead of hanging forever.
  const signal = AbortSignal.timeout(opts.timeoutMs);
  const res = await fetchFn(runnerUrl, {
    method: "POST",
    headers: out,
    body: JSON.stringify(payload),
    signal,
  });

  return {
    status: res.status,
    headers: res.headers,
    body: await res.arrayBuffer(),
  };
}

/** The logical task a run belongs to: replacement ids are `<root>:<target>[:...]`. */
export function idempotencyKeyFor(runId: string): string {
  return `ebbgate-run-${runId.split(":")[0]}`;
}
