import { loadAgentRuntime, readNodeId } from "./config.js";
import { readMode } from "./mode.js";
import { MODE_FILE, NODE_FILE } from "./paths.js";

export async function printStatus(
  env: NodeJS.ProcessEnv = process.env,
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  const lines: string[] = [];
  const node = readNodeId(env);
  lines.push(`mode: ${readMode()} (${MODE_FILE})`);
  lines.push(`node: ${node ?? "(unset)"} ${node ? `(${NODE_FILE})` : ""}`);

  try {
    const rt = loadAgentRuntime(env);
    lines.push(`dispatcher: ${rt.dispatcherUrl}`);
    lines.push(`gateway: ${rt.gatewayUrl}`);
    lines.push(`runnerPort: ${rt.runnerPort}`);
    lines.push(`config: ${rt.configPath}`);
    lines.push(`env file: ${rt.envFile ?? "(none)"}`);

    if (!rt.statusToken) {
      // A node does not hold the dispatcher's admin secret, and does not need it.
      lines.push("dispatcher /status: skipped (no admin secret available on this node)");
      return lines.join("\n");
    }
    try {
      const res = await fetchFn(`${rt.dispatcherUrl}/status`, {
        headers: { authorization: `Bearer ${rt.statusToken}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) await res.body?.cancel();
      if (res.ok) {
        const body = (await res.json()) as {
          nodes?: Array<{ node: string; state: string; lastSeenAt: string | null }>;
        };
        const mine = body.nodes?.find((n) => n.node === rt.node);
        if (mine) {
          lines.push(`dispatcher sees: ${mine.state} (lastSeenAt=${mine.lastSeenAt ?? "null"})`);
        } else {
          lines.push("dispatcher sees: (node not listed yet)");
        }
      } else {
        lines.push(`dispatcher /status: HTTP ${res.status}`);
      }
    } catch (err) {
      lines.push(`dispatcher /status: unreachable (${String(err)})`);
    }
  } catch (err) {
    lines.push(`runtime: ${String(err)}`);
  }

  return lines.join("\n");
}
