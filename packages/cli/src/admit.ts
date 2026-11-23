import { readFileSync } from "node:fs";

/**
 * `ebbgate admit`: an admission probe for orchestrators, built for Paperclip's
 * per-environment `capacity.admissionCommand` (paperclipai/paperclip#17402):
 * exit 0 admits the run, any non-zero exit refuses it. Paperclip kills the probe
 * after 10 s, so every step here is bounded well below that.
 *
 * Fails closed: a missing flag, an unreachable dispatcher, a bad answer or a
 * timeout all refuse.
 */

export const ADMIT_EXIT = { admit: 0, refuse: 1, error: 2 } as const;
export const DEFAULT_ADMIT_TIMEOUT_MS = 3_000;
const MAX_ADMIT_TIMEOUT_MS = 8_000;

export interface AdmitDeps {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  /** One-line diagnostics. Paperclip ignores the probe's output; humans read it. */
  log?: (line: string) => void;
  readFile?: (path: string) => string;
}

export interface AdmitArgs {
  dispatcher: string;
  secret: string;
  target: { kind: "node"; node: string } | { kind: "remote" };
  agentId?: string;
  environmentId?: string;
  issuePrivate: boolean;
  labels?: string[];
  timeoutMs: number;
  json: boolean;
}

export class AdmitUsageError extends Error {}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i === -1) {
    const eq = argv.find((a) => a.startsWith(`${name}=`));
    return eq?.slice(name.length + 1);
  }
  const v = argv[i + 1];
  if (v === undefined || v.startsWith("--")) throw new AdmitUsageError(`${name} needs a value`);
  return v;
}

const truthy = (v: string | undefined) => v !== undefined && /^(1|true|yes)$/i.test(v.trim());

/** Flags win over env. Secrets come only from env or a file, never argv (visible in `ps`). */
export function parseAdmitArgs(
  argv: string[],
  env: NodeJS.ProcessEnv,
  readFile: (path: string) => string,
): AdmitArgs {
  const known = new Set([
    "--dispatcher",
    "--node",
    "--remote",
    "--agent",
    "--environment",
    "--private",
    "--labels",
    "--timeout-ms",
    "--secret-file",
    "--json",
  ]);
  for (const a of argv) {
    if (a.startsWith("--") && !known.has(a.split("=")[0] as string)) {
      throw new AdmitUsageError(`unknown flag ${a.split("=")[0]}`);
    }
  }

  const node = flag(argv, "--node") ?? env.EBBGATE_NODE;
  const remote = argv.includes("--remote") || truthy(env.EBBGATE_REMOTE);
  if (node && remote) throw new AdmitUsageError("use either --node <id> or --remote, not both");
  if (!node && !remote)
    throw new AdmitUsageError("say where this environment runs: --node <id> or --remote");

  const secretFile = flag(argv, "--secret-file") ?? env.EBBGATE_SECRET_FILE;
  const secret = (secretFile ? readFile(secretFile) : (env.EG_PAPERCLIP_SECRET ?? "")).trim();
  if (!secret)
    throw new AdmitUsageError("no dispatcher secret: set EG_PAPERCLIP_SECRET or --secret-file");

  const labelsRaw = flag(argv, "--labels") ?? env.EBBGATE_LABELS;
  const timeoutRaw = flag(argv, "--timeout-ms") ?? env.EBBGATE_ADMIT_TIMEOUT_MS;
  const timeoutMs = timeoutRaw === undefined ? DEFAULT_ADMIT_TIMEOUT_MS : Number(timeoutRaw);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > MAX_ADMIT_TIMEOUT_MS) {
    throw new AdmitUsageError(`--timeout-ms must be 100..${MAX_ADMIT_TIMEOUT_MS}`);
  }

  // TODO(verify-paperclip): Paperclip#17402 passes no run context to the probe today
  // (static argv, inherited env). EBBGATE_AGENT_ID etc. are for wrappers or a future
  // context hand-off; see docs/paperclip-admission.md.
  const agentId = flag(argv, "--agent") ?? env.EBBGATE_AGENT_ID;
  const environmentId = flag(argv, "--environment") ?? env.EBBGATE_ENVIRONMENT_ID;
  const dispatcher = (
    flag(argv, "--dispatcher") ??
    env.EBBGATE_DISPATCHER_URL ??
    "http://127.0.0.1:8790"
  ).replace(/\/+$/, "");
  try {
    new URL(dispatcher);
  } catch {
    throw new AdmitUsageError("--dispatcher must be a URL");
  }

  return {
    dispatcher,
    secret,
    target: node ? { kind: "node", node } : { kind: "remote" },
    ...(agentId ? { agentId } : {}),
    ...(environmentId ? { environmentId } : {}),
    issuePrivate: argv.includes("--private") || truthy(env.EBBGATE_ISSUE_PRIVATE),
    ...(labelsRaw !== undefined
      ? {
          labels: labelsRaw
            .split(",")
            .map((l) => l.trim())
            .filter(Boolean),
        }
      : {}),
    timeoutMs,
    json: argv.includes("--json"),
  };
}

/** Run the probe and return the exit code. Never throws. */
export async function runAdmit(argv: string[], deps: AdmitDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const fetchFn = deps.fetch ?? fetch;
  const log = deps.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, "utf8"));

  let args: AdmitArgs;
  try {
    args = parseAdmitArgs(argv, env, readFile);
  } catch (err) {
    log(
      `ebbgate admit: refuse (usage: ${err instanceof AdmitUsageError ? err.message : "invalid arguments"})`,
    );
    return ADMIT_EXIT.error;
  }

  const body = {
    target: args.target.kind,
    ...(args.target.kind === "node" ? { node: args.target.node } : {}),
    ...(args.agentId ? { agentId: args.agentId } : {}),
    ...(args.environmentId ? { environmentId: args.environmentId } : {}),
    ...(args.issuePrivate ? { issuePrivate: true } : {}),
    ...(args.labels ? { labels: args.labels } : {}),
  };

  try {
    const res = await fetchFn(`${args.dispatcher}/admit`, {
      method: "POST",
      headers: { authorization: `Bearer ${args.secret}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(args.timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) {
      log(`ebbgate admit: refuse (dispatcher answered HTTP ${res.status})`);
      return ADMIT_EXIT.error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      log("ebbgate admit: refuse (dispatcher answer was not JSON)");
      return ADMIT_EXIT.error;
    }
    const r = parsed as { admit?: unknown; tier?: unknown; reason?: unknown };
    if (typeof r.admit !== "boolean") {
      log("ebbgate admit: refuse (dispatcher answer had no admit field)");
      return ADMIT_EXIT.error;
    }
    const reason = typeof r.reason === "string" ? r.reason : "";
    const where = args.target.kind === "node" ? `node ${args.target.node}` : "remote";
    if (args.json) {
      log(JSON.stringify({ admit: r.admit, tier: r.tier, target: where, reason }));
    } else {
      log(
        `ebbgate admit: ${r.admit ? "admit" : "refuse"} ${where} (tier=${String(r.tier)}; ${reason})`,
      );
    }
    return r.admit === true ? ADMIT_EXIT.admit : ADMIT_EXIT.refuse;
  } catch (err) {
    const timedOut =
      err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    log(
      `ebbgate admit: refuse (${timedOut ? `dispatcher did not answer within ${args.timeoutMs} ms` : "dispatcher unreachable"})`,
    );
    return ADMIT_EXIT.error;
  }
}
