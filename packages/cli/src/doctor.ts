import { accessSync, constants, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseEnvFile } from "@ebbgate/agent";
import { ConfigError, type EbbgateConfig, loadConfig } from "@ebbgate/core";
import { SECRETS_FILE } from "./generate/secrets-file.js";

/**
 * `ebbgate doctor`: one line per check, each with a fix. Read-only apart from
 * creating the database directory the dispatcher would create anyway. Never prints
 * a secret: messages name variables and files, not values.
 */

export type CheckStatus = "pass" | "warn" | "fail";

export interface CheckResult {
  id: string;
  title: string;
  status: CheckStatus;
  message: string;
  /** What to do about a warn or fail. */
  fix?: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: CheckResult[];
}

export interface DoctorOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  now?: () => Date;
  /** Node.js version to check, e.g. "22.12.0". Defaults to the running one. */
  nodeVersion?: string;
  /** Explicit config path (--config). */
  configPath?: string;
  /** Per-request timeout for network checks. */
  timeoutMs?: number;
}

export const MIN_NODE_MAJOR = 22;
const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";
/** Stands in for unset ${VARS}, so the rest of the config can still be checked. */
const PLACEHOLDER = "ebbgate-doctor-placeholder-value";

interface Context {
  cwd: string;
  env: NodeJS.ProcessEnv;
  fetchFn: typeof fetch;
  now: () => Date;
  timeoutMs: number;
  configPath?: string;
  secretsPath?: string;
  /** Process env plus the secrets file (process env wins, as for the agent). */
  merged: NodeJS.ProcessEnv;
  /** Parsed config; unset variables replaced by PLACEHOLDER. */
  config?: EbbgateConfig;
  missingVars: Set<string>;
}

export async function runDoctor(opts: DoctorOptions = {}): Promise<DoctorReport> {
  const env = opts.env ?? process.env;
  const ctx: Context = {
    cwd: resolve(opts.cwd ?? process.cwd()),
    env,
    fetchFn: opts.fetch ?? fetch,
    now: opts.now ?? (() => new Date()),
    timeoutMs: opts.timeoutMs ?? 2_000,
    merged: { ...env },
    missingVars: new Set(),
  };

  const checks: CheckResult[] = [checkNode(opts.nodeVersion ?? process.versions.node)];
  checks.push(checkConfig(ctx, opts.configPath));
  checks.push(checkSecretsFile(ctx));
  const dispatcher = await checkDispatcher(ctx);
  checks.push(...dispatcher.results);
  checks.push(checkHeartbeat(ctx, dispatcher.nodes));
  checks.push(await checkOllama(ctx));
  checks.push(checkCloud(ctx));
  checks.push(checkSqlite(ctx));
  checks.push(await checkPaperclip(ctx));

  return { ok: checks.every((c) => c.status !== "fail"), checks };
}

/* ------------------------------------------------------------------ */

export function checkNode(version: string): CheckResult {
  const major = Number(version.replace(/^v/, "").split(".")[0]);
  const title = "Node.js";
  if (Number.isFinite(major) && major >= MIN_NODE_MAJOR) {
    return { id: "node", title, status: "pass", message: `v${version.replace(/^v/, "")}` };
  }
  return {
    id: "node",
    title,
    status: "fail",
    message: `v${version.replace(/^v/, "")} is too old; Ebbgate needs Node ${MIN_NODE_MAJOR} or newer`,
    fix: `install Node ${MIN_NODE_MAJOR}+ (e.g. \`brew install node@${MIN_NODE_MAJOR}\` or nvm)`,
  };
}

function findConfig(ctx: Context, explicit?: string): string | undefined {
  const chosen = explicit ?? ctx.env.EBBGATE_CONFIG;
  if (chosen) return resolve(ctx.cwd, chosen);
  const local = resolve(ctx.cwd, "ebbgate.yaml");
  if (existsSync(local)) return local;
  const home = ctx.env.HOME ? resolve(ctx.env.HOME, ".ebbgate", "ebbgate.yaml") : undefined;
  if (home && existsSync(home)) return home;
  return undefined;
}

function findSecrets(ctx: Context): string | undefined {
  if (ctx.env.EBBGATE_ENV_FILE) return resolve(ctx.cwd, ctx.env.EBBGATE_ENV_FILE);
  const base = ctx.configPath ? dirname(ctx.configPath) : ctx.cwd;
  const candidate = resolve(base, SECRETS_FILE);
  return existsSync(candidate) ? candidate : undefined;
}

function checkConfig(ctx: Context, explicit?: string): CheckResult {
  const title = "Config";
  const configPath = findConfig(ctx, explicit);
  if (!configPath || !existsSync(configPath)) {
    return {
      id: "config",
      title,
      status: "fail",
      message: configPath ? `${configPath} not found` : "no ebbgate.yaml in this directory",
      fix: "run `ebbgate init` (or pass --config / set EBBGATE_CONFIG)",
    };
  }
  ctx.configPath = configPath;
  const secretsPath = findSecrets(ctx);
  if (secretsPath) ctx.secretsPath = secretsPath;
  if (ctx.secretsPath && existsSync(ctx.secretsPath)) {
    try {
      ctx.merged = { ...parseEnvFile(readFileSync(ctx.secretsPath, "utf8")), ...ctx.env };
    } catch {
      // reported by the secrets check
    }
  }

  let text: string;
  try {
    text = readFileSync(configPath, "utf8");
  } catch {
    return {
      id: "config",
      title,
      status: "fail",
      message: `cannot read ${configPath}`,
      fix: `check the file's permissions: ls -l ${configPath}`,
    };
  }

  try {
    ctx.config = loadConfig(text, ctx.merged);
    return { id: "config", title, status: "pass", message: `${configPath} is valid` };
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    const missing = err.issues
      .map((i) => /environment variable ([A-Z_][A-Z0-9_]*) is not set/.exec(i.message)?.[1])
      .filter((v): v is string => Boolean(v));
    const other = err.issues.filter((i) => !/environment variable .* is not set/.test(i.message));
    if (other.length === 0 && missing.length > 0) {
      // Structure is fine; check the rest with placeholders for the unset secrets.
      for (const v of missing) ctx.missingVars.add(v);
      const filled = { ...ctx.merged };
      for (const v of missing) filled[v] = PLACEHOLDER;
      try {
        ctx.config = loadConfig(text, filled);
      } catch {
        // leave config undefined
      }
      const where = ctx.secretsPath ?? resolve(dirname(configPath), SECRETS_FILE);
      return {
        id: "config",
        title,
        status: "fail",
        message: `${configPath} needs ${[...new Set(missing)].join(", ")}`,
        fix: `add ${[...new Set(missing)].map((v) => `${v}=…`).join(" and ")} to ${where}`,
      };
    }
    return {
      id: "config",
      title,
      status: "fail",
      message: `${configPath}: ${other.map((i) => `${i.path || "(root)"}: ${i.message}`).join("; ")}`,
      fix: "fix the listed fields (see ebbgate.example.yaml), or re-run `ebbgate init --force`",
    };
  }
}

function checkSecretsFile(ctx: Context): CheckResult {
  const title = "Secrets file";
  const path = ctx.secretsPath;
  if (!path) {
    return {
      id: "secrets",
      title,
      status: "warn",
      message: "no .env next to the config; secrets must come from the environment",
      fix: "run `ebbgate init` to generate .env (mode 600), or set EBBGATE_ENV_FILE",
    };
  }
  if (!existsSync(path)) {
    return {
      id: "secrets",
      title,
      status: "fail",
      message: `${path} not found (from EBBGATE_ENV_FILE)`,
      fix: "point EBBGATE_ENV_FILE at your secrets file, or run `ebbgate init`",
    };
  }
  const mode = statSync(path).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    return {
      id: "secrets",
      title,
      status: "fail",
      message: `${path} is readable by other users (mode ${mode.toString(8)})`,
      fix: `chmod 600 ${path}`,
    };
  }
  return { id: "secrets", title, status: "pass", message: `${path} (mode ${mode.toString(8)})` };
}

function dispatcherBase(ctx: Context): string | undefined {
  const fromEnv = ctx.env.EBBGATE_DISPATCHER_URL;
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  return ctx.config?.server.publicUrl.replace(/\/$/, "");
}

interface NodeStatusLite {
  node: string;
  state?: string;
  lastSeenAt: string | null;
}

async function checkDispatcher(
  ctx: Context,
): Promise<{ results: CheckResult[]; nodes?: NodeStatusLite[] }> {
  const title = "Dispatcher";
  const base = dispatcherBase(ctx);
  if (!base) {
    return {
      results: [
        {
          id: "dispatcher",
          title,
          status: "warn",
          message: "skipped: no valid config to find the dispatcher URL",
          fix: "fix the config check first, or set EBBGATE_DISPATCHER_URL",
        },
      ],
    };
  }
  try {
    const res = await get(ctx, `${base}/healthz`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    return {
      results: [
        {
          id: "dispatcher",
          title,
          status: "fail",
          message: `${base} not reachable (${describe(err)})`,
          fix: "start it: `ebbgate serve` in the folder with ebbgate.yaml (or set EBBGATE_DISPATCHER_URL)",
        },
      ],
    };
  }
  const reach: CheckResult = { id: "dispatcher", title, status: "pass", message: `${base} is up` };

  const secret = ctx.merged.EG_PAPERCLIP_SECRET;
  if (!secret || ctx.missingVars.has("EG_PAPERCLIP_SECRET")) {
    return {
      results: [
        reach,
        {
          id: "dispatcher-auth",
          title: "Dispatcher auth",
          status: "warn",
          message: "skipped: EG_PAPERCLIP_SECRET is not set",
          fix: "add EG_PAPERCLIP_SECRET to .env (`ebbgate init` generates one)",
        },
      ],
    };
  }
  try {
    const res = await get(ctx, `${base}/status`, { authorization: `Bearer ${secret}` });
    if (res.status === 401) {
      return {
        results: [
          reach,
          {
            id: "dispatcher-auth",
            title: "Dispatcher auth",
            status: "fail",
            message: "the running dispatcher rejects EG_PAPERCLIP_SECRET from .env",
            fix: "restart the dispatcher with this .env, or copy its EG_PAPERCLIP_SECRET here",
          },
        ],
      };
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { nodes?: NodeStatusLite[] };
    return {
      results: [
        reach,
        {
          id: "dispatcher-auth",
          title: "Dispatcher auth",
          status: "pass",
          message: "EG_PAPERCLIP_SECRET accepted",
        },
      ],
      nodes: Array.isArray(body.nodes) ? body.nodes : [],
    };
  } catch (err) {
    return {
      results: [
        reach,
        {
          id: "dispatcher-auth",
          title: "Dispatcher auth",
          status: "fail",
          message: `GET /status failed (${describe(err)})`,
          fix: "check the dispatcher logs",
        },
      ],
    };
  }
}

function checkHeartbeat(ctx: Context, nodes?: NodeStatusLite[]): CheckResult {
  const title = "Presence heartbeat";
  if (!nodes) {
    return {
      id: "heartbeat",
      title,
      status: "warn",
      message: "skipped: dispatcher status unavailable",
      fix: "fix the dispatcher checks first",
    };
  }
  const maxAge = ctx.config?.presence.offlineAfterSeconds ?? 90;
  const configured = ctx.config ? Object.keys(ctx.config.nodes) : nodes.map((n) => n.node);
  const fresh: string[] = [];
  const problems: string[] = [];
  for (const id of configured) {
    const n = nodes.find((x) => x.node === id);
    if (!n?.lastSeenAt) {
      problems.push(`${id}: never reported`);
      continue;
    }
    const ageS = Math.round((ctx.now().getTime() - Date.parse(n.lastSeenAt)) / 1000);
    if (Number.isFinite(ageS) && ageS <= maxAge) fresh.push(`${id} (${Math.max(0, ageS)}s ago)`);
    else problems.push(`${id}: last seen ${ageS}s ago`);
  }
  if (problems.length === 0) {
    return { id: "heartbeat", title, status: "pass", message: `fresh: ${fresh.join(", ")}` };
  }
  const first = problems[0]?.split(":")[0] ?? "<id>";
  return {
    id: "heartbeat",
    title,
    status: "warn",
    message: `${problems.join("; ")} (offline after ${maxAge}s)`,
    fix: `on that Mac: \`ebbgate agent install --node ${first}\`, then \`ebbgate status\``,
  };
}

async function checkOllama(ctx: Context): Promise<CheckResult> {
  const title = "Ollama";
  const base = (ctx.merged.EBBGATE_OLLAMA_URL ?? DEFAULT_OLLAMA_URL).replace(/\/$/, "");
  try {
    const res = await get(ctx, `${base}/api/tags`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json().catch(() => ({}))) as { models?: unknown[] };
    const count = Array.isArray(body.models) ? body.models.length : 0;
    if (count === 0) {
      return {
        id: "ollama",
        title,
        status: "warn",
        message: `${base} is up but has no models`,
        fix: "pull one: `ollama pull llama3.2`",
      };
    }
    return { id: "ollama", title, status: "pass", message: `${base} (${count} model(s))` };
  } catch (err) {
    return {
      id: "ollama",
      title,
      status: "warn",
      message: `${base} not reachable (${describe(err)}); local runs need a local model`,
      fix: "install and start Ollama (`brew install ollama && ollama serve`), or set EBBGATE_OLLAMA_URL",
    };
  }
}

function checkCloud(ctx: Context): CheckResult {
  const title = "Cloud runner";
  if (!ctx.config) {
    return {
      id: "cloud",
      title,
      status: "warn",
      message: "skipped: no valid config",
      fix: "fix the config check first",
    };
  }
  const runner = ctx.config.cloud?.runner;
  if (!runner) {
    return {
      id: "cloud",
      title,
      status: "pass",
      message: "none configured: nothing leaves your machines (work waits for a local node)",
    };
  }
  let url: URL;
  try {
    url = new URL(runner);
  } catch {
    return { id: "cloud", title, status: "fail", message: "cloud.runner is not a URL" };
  }
  const local =
    url.hostname === "localhost" ||
    url.hostname.startsWith("127.") ||
    url.hostname === "[::1]" ||
    !url.hostname.includes(".");
  if (url.protocol !== "https:" && !local) {
    return {
      id: "cloud",
      title,
      status: "warn",
      message: `${url.origin} uses plain http; task payloads cross the network unencrypted`,
      fix: "use an https:// cloud runner, or reach it over a VPN such as Tailscale",
    };
  }
  return {
    id: "cloud",
    title,
    status: "pass",
    message: `${url.origin} (private tasks are never sent here)`,
  };
}

function checkSqlite(ctx: Context): CheckResult {
  const title = "SQLite queue";
  const raw = ctx.merged.EBBGATE_DB ?? "./data/ebbgate.db";
  if (raw === ":memory:" || raw.startsWith("file:")) {
    return { id: "sqlite", title, status: "warn", message: `${raw}: deferred work is not durable` };
  }
  const path = resolve(ctx.cwd, raw);
  const dir = dirname(path);
  try {
    mkdirSync(dir, { recursive: true });
    accessSync(dir, constants.W_OK);
    for (const f of [path, `${path}-wal`, `${path}-shm`]) {
      if (existsSync(f)) accessSync(f, constants.R_OK | constants.W_OK);
    }
    if (existsSync(path) && statSync(path).size > 0) {
      const head = readFileSync(path).subarray(0, 16).toString("latin1");
      if (!head.startsWith("SQLite format 3")) {
        return {
          id: "sqlite",
          title,
          status: "fail",
          message: `${path} exists but is not a SQLite database`,
          fix: "point EBBGATE_DB at a new path, or move the file aside",
        };
      }
    }
  } catch (err) {
    return {
      id: "sqlite",
      title,
      status: "fail",
      message: `${path} is not writable (${describe(err)})`,
      fix: `make ${dir} writable by this user, or set EBBGATE_DB to a writable path`,
    };
  }
  return { id: "sqlite", title, status: "pass", message: `${path} is writable` };
}

async function checkPaperclip(ctx: Context): Promise<CheckResult> {
  const title = "Paperclip";
  const key = ctx.merged.PAPERCLIP_API_KEY;
  if (!ctx.config || !key || ctx.missingVars.has("PAPERCLIP_API_KEY")) {
    return {
      id: "paperclip",
      title,
      status: "warn",
      message: "skipped: PAPERCLIP_API_KEY not configured",
      fix: "add PAPERCLIP_API_KEY to .env (Paperclip → Settings → API keys)",
    };
  }
  const base = ctx.config.paperclip.apiUrl.replace(/\/$/, "");
  try {
    const res = await get(ctx, `${base}/api/health`, { authorization: `Bearer ${key}` });
    if (res.status >= 500) throw new Error(`HTTP ${res.status}`);
    return { id: "paperclip", title, status: "pass", message: `${base} is reachable` };
  } catch (err) {
    return {
      id: "paperclip",
      title,
      status: "fail",
      message: `${base} not reachable (${describe(err)})`,
      fix: "start Paperclip, or fix paperclip.apiUrl in ebbgate.yaml",
    };
  }
}

/* ------------------------------------------------------------------ */

async function get(
  ctx: Context,
  url: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return ctx.fetchFn(url, {
    method: "GET",
    headers: { accept: "application/json", ...headers },
    signal: AbortSignal.timeout(ctx.timeoutMs),
  });
}

/** Error text without URLs' query strings or anything echoed from a server. */
function describe(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === "TimeoutError" || err.name === "AbortError") return "timed out";
    const cause = (err as { cause?: { code?: string } }).cause?.code;
    return cause ?? err.message.split("\n")[0]?.slice(0, 120) ?? "error";
  }
  return "error";
}

const ICON: Record<CheckStatus, string> = { pass: "PASS", warn: "WARN", fail: "FAIL" };

/** Plain-text report: one line per check, a fix line under each warn/fail. */
export function formatDoctorReport(report: DoctorReport): string {
  const width = Math.max(...report.checks.map((c) => c.title.length));
  const lines: string[] = [];
  for (const c of report.checks) {
    lines.push(`${ICON[c.status]}  ${c.title.padEnd(width)}  ${c.message}`);
    if (c.fix && c.status !== "pass") lines.push(`      ${" ".repeat(width)}  fix: ${c.fix}`);
  }
  const fails = report.checks.filter((c) => c.status === "fail").length;
  const warns = report.checks.filter((c) => c.status === "warn").length;
  lines.push("");
  lines.push(
    fails > 0
      ? `${fails} failed, ${warns} warning(s). Fix the FAIL lines and run \`ebbgate doctor\` again.`
      : warns > 0
        ? `All required checks passed, ${warns} warning(s).`
        : "All checks passed.",
  );
  return lines.join("\n");
}

/** CLI entry: returns the exit code (0 ok, 1 any failure). */
export async function runDoctorCommand(
  args: string[],
  opts: DoctorOptions & { write?: (s: string) => void } = {},
): Promise<number> {
  const write = opts.write ?? ((s: string) => process.stdout.write(`${s}\n`));
  const i = args.indexOf("--config");
  const configPath = i >= 0 ? args[i + 1] : undefined;
  const report = await runDoctor({ ...opts, ...(configPath ? { configPath } : {}) });
  write(args.includes("--json") ? JSON.stringify(report, null, 2) : formatDoctorReport(report));
  return report.ok ? 0 : 1;
}
