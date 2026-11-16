export interface RunnerResult {
  status: number;
  headers: Headers;
  body: ArrayBuffer;
}

/** Forward the original Paperclip payload to a local or cloud runner. */
export async function forwardToRunner(
  runnerUrl: string,
  payload: unknown,
  headers: Headers,
  fetchFn: typeof fetch = fetch,
): Promise<RunnerResult> {
  const out = new Headers();
  const auth = headers.get("authorization");
  if (auth) out.set("authorization", auth);
  out.set("content-type", "application/json");
  // TODO(verify-paperclip): which headers runners expect beyond Authorization.

  const res = await fetchFn(runnerUrl, {
    method: "POST",
    headers: out,
    body: JSON.stringify(payload),
  });

  return {
    status: res.status,
    headers: res.headers,
    body: await res.arrayBuffer(),
  };
}
