import { readFileSync } from "node:fs";
import {
  formatDecisionLine,
  formatDispatcherStatus,
  formatWhy,
  printStatus,
  readMode,
  type StatusDecision,
} from "@ebbgate/agent";

/**
 * Explainability commands against the dispatcher (all read-only, all behind the
 * shared secret):
 *   ebbgate status [--json]            presence, queue counts, why each task waits
 *   ebbgate why <taskId> [--json]      every decision for one task, and why
 *   ebbgate decisions [filters] [--json]  the audit log, newest first
 *
 * The secret comes only from env (EG_PAPERCLIP_SECRET) or a file, never argv.
 */

export const EXPLAIN_EXIT = { ok: 0, notFound: 1, error: 2 } as const;
const TIMEOUT_MS = 5_000;

export interface ExplainDeps {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  out?: (line: string) => void;
  err?: (line: string) => void;
  readFile?: (path: string) => string;
  now?: () => Date;
  /** Fallback for `ebbgate status` when no dispatcher secret is available. */
  localStatus?: () => Promise<string>;
}

export class ExplainUsageError extends Error {}

interface Common {
  dispatcher: string;
  secret: string | null;
  json: boolean;
  rest: string[];
  flags: Map<string, string>;
}

const VALUE_FLAGS = new Set([
  "--dispatcher",
  "--secret-file",
  "--task",
  "--agent",
  "--kind",
  "--limit",
]);

/** Split argv into value flags, boolean flags and positionals. Unknown flags are errors. */
export function parseExplainArgs(
  argv: string[],
  env: NodeJS.ProcessEnv,
  readFile: (path: string) => string,
  allowed: readonly string[],
): Common {
  const flags = new Map<string, string>();
  const rest: string[] = [];
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (!a.startsWith("--")) {
      rest.push(a);
      continue;
    }
    const [name, inline] = a.split(/=(.*)/s, 2) as [string, string | undefined];
    if (name === "--json") {
      json = true;
      continue;
    }
    if (!VALUE_FLAGS.has(name) || !allowed.includes(name)) {
      throw new ExplainUsageError(`unknown flag ${name}`);
    }
    const value = inline ?? argv[++i];
    if (value === undefined || value.startsWith("--"))
      throw new ExplainUsageError(`${name} needs a value`);
    flags.set(name, value);
  }
  const dispatcher = (
    flags.get("--dispatcher") ??
    env.EBBGATE_DISPATCHER_URL ??
    "http://127.0.0.1:8790"
  ).replace(/\/+$/, "");
  try {
    new URL(dispatcher);
  } catch {
    throw new ExplainUsageError("--dispatcher must be a URL");
  }
  const secretFile = flags.get("--secret-file") ?? env.EBBGATE_SECRET_FILE;
  const secret = (secretFile ? readFile(secretFile) : (env.EG_PAPERCLIP_SECRET ?? "")).trim();
  return { dispatcher, secret: secret || null, json, rest, flags };
}

async function getJson(
  c: Common,
  path: string,
  fetchFn: typeof fetch,
): Promise<{ ok: true; body: unknown } | { ok: false; message: string }> {
  if (!c.secret) {
    return { ok: false, message: "no dispatcher secret: set EG_PAPERCLIP_SECRET or --secret-file" };
  }
  try {
    const res = await fetchFn(`${c.dispatcher}${path}`, {
      headers: { authorization: `Bearer ${c.secret}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      await res.body?.cancel();
      return { ok: false, message: `dispatcher answered HTTP ${res.status}` };
    }
    return { ok: true, body: await res.json() };
  } catch (err) {
    const timedOut =
      err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    return {
      ok: false,
      message: timedOut
        ? `dispatcher did not answer within ${TIMEOUT_MS} ms`
        : "dispatcher unreachable",
    };
  }
}

function resolveDeps(deps: ExplainDeps) {
  return {
    env: deps.env ?? process.env,
    fetchFn: deps.fetch ?? fetch,
    out: deps.out ?? ((l: string) => process.stdout.write(`${l}\n`)),
    err: deps.err ?? ((l: string) => process.stderr.write(`${l}\n`)),
    readFile: deps.readFile ?? ((p: string) => readFileSync(p, "utf8")),
    now: deps.now ?? (() => new Date()),
  };
}

/** `ebbgate status`. Without a dispatcher secret, falls back to the node-local view. */
export async function runStatusCommand(argv: string[], deps: ExplainDeps = {}): Promise<number> {
  const d = resolveDeps(deps);
  let c: Common;
  try {
    c = parseExplainArgs(argv, d.env, d.readFile, ["--dispatcher", "--secret-file"]);
  } catch (e) {
    d.err(`ebbgate status: ${(e as Error).message}`);
    return EXPLAIN_EXIT.error;
  }
  if (!c.secret && !c.json) {
    d.out(await (deps.localStatus ?? (() => printStatus(d.env)))());
    return EXPLAIN_EXIT.ok;
  }
  const r = await getJson(c, "/status", d.fetchFn);
  if (!r.ok) {
    d.err(`ebbgate status: ${r.message}`);
    return EXPLAIN_EXIT.error;
  }
  if (c.json) {
    d.out(JSON.stringify(r.body, null, 2));
    return EXPLAIN_EXIT.ok;
  }
  let mode = "auto";
  try {
    mode = readMode();
  } catch {
    // no local mode file: fine on the dispatcher host
  }
  d.out(
    [
      `dispatcher: ${c.dispatcher}`,
      `local mode: ${mode}`,
      ...formatDispatcherStatus(r.body, d.now()),
    ].join("\n"),
  );
  return EXPLAIN_EXIT.ok;
}

const TASK_ID = /^[A-Za-z0-9._:-]{1,160}$/;

/** `ebbgate why <taskId>`: exit 0 found, 1 no decisions recorded, 2 error. */
export async function runWhy(argv: string[], deps: ExplainDeps = {}): Promise<number> {
  const d = resolveDeps(deps);
  let c: Common;
  try {
    c = parseExplainArgs(argv, d.env, d.readFile, ["--dispatcher", "--secret-file"]);
  } catch (e) {
    d.err(`ebbgate why: ${(e as Error).message}`);
    return EXPLAIN_EXIT.error;
  }
  const taskId = c.rest[0];
  if (!taskId || c.rest.length > 1 || !TASK_ID.test(taskId)) {
    d.err("usage: ebbgate why <taskId> [--json]");
    return EXPLAIN_EXIT.error;
  }
  const r = await getJson(c, `/decisions?taskId=${encodeURIComponent(taskId)}&limit=50`, d.fetchFn);
  if (!r.ok) {
    d.err(`ebbgate why: ${r.message}`);
    return EXPLAIN_EXIT.error;
  }
  const body = r.body as { decisions?: unknown[]; waiting?: unknown };
  const found = (Array.isArray(body.decisions) && body.decisions.length > 0) || !!body.waiting;
  if (c.json) d.out(JSON.stringify({ taskId, ...body }, null, 2));
  else d.out(formatWhy(taskId, body, d.now()).join("\n"));
  return found ? EXPLAIN_EXIT.ok : EXPLAIN_EXIT.notFound;
}

/** `ebbgate decisions [--task ID] [--agent ID] [--kind route|admission] [--limit N]`. */
export async function runDecisions(argv: string[], deps: ExplainDeps = {}): Promise<number> {
  const d = resolveDeps(deps);
  let c: Common;
  try {
    c = parseExplainArgs(argv, d.env, d.readFile, [
      "--dispatcher",
      "--secret-file",
      "--task",
      "--agent",
      "--kind",
      "--limit",
    ]);
    if (c.rest.length > 0) throw new ExplainUsageError(`unexpected argument ${c.rest[0]}`);
  } catch (e) {
    d.err(`ebbgate decisions: ${(e as Error).message}`);
    return EXPLAIN_EXIT.error;
  }
  const q = new URLSearchParams();
  const task = c.flags.get("--task");
  const agent = c.flags.get("--agent");
  const kind = c.flags.get("--kind");
  if (task) q.set("taskId", task);
  if (agent) q.set("agentId", agent);
  if (kind) q.set("kind", kind);
  q.set("limit", c.flags.get("--limit") ?? "20");
  const r = await getJson(c, `/decisions?${q}`, d.fetchFn);
  if (!r.ok) {
    d.err(`ebbgate decisions: ${r.message}`);
    return EXPLAIN_EXIT.error;
  }
  const decisions = (r.body as { decisions?: unknown }).decisions;
  const list = Array.isArray(decisions) ? (decisions as StatusDecision[]) : [];
  if (c.json) d.out(JSON.stringify(list, null, 2));
  else if (list.length === 0) d.out("no decisions recorded");
  else for (const entry of list) d.out(formatDecisionLine(entry));
  return EXPLAIN_EXIT.ok;
}
