import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { type LoadedEnvFile, loadEnvFile } from "./envfile.js";
import { readNodeCredentials } from "./node-credentials.js";
import {
  AGENT_CONFIG_FILE,
  DEFAULT_DISPATCHER_URL,
  DEFAULT_GATEWAY_URL,
  DEFAULT_RUNNER_HOST,
  EBBGATE_DIR,
  NODE_FILE,
} from "./paths.js";

export interface AgentRuntimeConfig {
  node: string;
  token: string;
  dispatcherUrl: string;
  gatewayUrl: string;
  runnerPort: number;
  runnerHost: string;
  ollamaUrl: string;
  /** Absolute path to the ebbgate.yaml used for tokens / nodes. */
  configPath: string;
  /** Env file the secrets were read from, if any. */
  envFile?: string;
  /** Dispatcher admin secret for `ebbgate status`, only if available. Never required. */
  statusToken?: string;
}

export interface AgentLocalFile {
  node?: string;
  dispatcherUrl?: string;
  gatewayUrl?: string;
  runnerPort?: number;
  runnerHost?: string;
  ollamaUrl?: string;
  configPath?: string;
  envFile?: string;
}

export function readNodeId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.EBBGATE_NODE?.trim()) return env.EBBGATE_NODE.trim();
  try {
    const n = readFileSync(NODE_FILE, "utf8").trim();
    return n || undefined;
  } catch {
    return undefined;
  }
}

export function writeNodeId(node: string): void {
  mkdirSync(EBBGATE_DIR, { recursive: true });
  writeFileSync(NODE_FILE, `${node}\n`, { mode: 0o600 });
}

export function readAgentLocalFile(path = AGENT_CONFIG_FILE): AgentLocalFile {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as AgentLocalFile;
  } catch {
    return {};
  }
}

export function writeAgentLocalFile(data: AgentLocalFile, path = AGENT_CONFIG_FILE): void {
  mkdirSync(EBBGATE_DIR, { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
}

export function resolveConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  local: AgentLocalFile = readAgentLocalFile(),
): string {
  for (const [source, value] of [
    ["EBBGATE_CONFIG", env.EBBGATE_CONFIG],
    ["saved configPath", local.configPath],
  ] as const) {
    if (!value) continue;
    const path = resolve(value);
    if (!existsSync(path)) throw new Error(`config not found: ${path} (from ${source})`);
    return path;
  }
  const cwd = resolve("ebbgate.yaml");
  if (existsSync(cwd)) return cwd;
  const home = resolve(EBBGATE_DIR, "ebbgate.yaml");
  if (existsSync(home)) return home;
  throw new Error(
    "no ebbgate.yaml found; set EBBGATE_CONFIG or place ebbgate.yaml in cwd / ~/.ebbgate/",
  );
}

/**
 * Where a node's secrets come from, in order: EBBGATE_ENV_FILE, the path saved at
 * install, a `.env` next to the config, then ~/.ebbgate/.env. An explicitly chosen
 * file must exist; the fallbacks are used only if present.
 */
export function resolveEnvFile(
  env: NodeJS.ProcessEnv,
  local: AgentLocalFile,
  configPath: string,
): string | undefined {
  const explicit = env.EBBGATE_ENV_FILE ?? local.envFile;
  if (explicit) {
    const path = resolve(explicit);
    if (!existsSync(path)) throw new Error(`env file not found: ${path}`);
    return path;
  }
  for (const candidate of [resolve(dirname(configPath), ".env"), resolve(EBBGATE_DIR, ".env")]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

export interface LoadRuntimeOptions {
  /** Saved install settings (defaults to ~/.ebbgate/agent.json). */
  local?: AgentLocalFile;
  /** Receives non-fatal warnings, such as loose env-file permissions. */
  onWarning?: (message: string) => void;
}

/**
 * Everything the daemon and runner need. Works in a clean shell and under launchd:
 * secrets come from the process environment or the env file (process env wins), and
 * only this node's token is read from ebbgate.yaml.
 */
export function loadAgentRuntime(
  env: NodeJS.ProcessEnv = process.env,
  opts: LoadRuntimeOptions = {},
): AgentRuntimeConfig {
  const local = opts.local ?? readAgentLocalFile();
  const configPath = resolveConfigPath(env, local);
  const envFilePath = resolveEnvFile(env, local, configPath);
  let file: LoadedEnvFile | undefined;
  if (envFilePath) {
    file = loadEnvFile(envFilePath);
    if (file.warning) (opts.onWarning ?? ((m) => console.error(`ebbgate: ${m}`)))(file.warning);
  }
  const merged: NodeJS.ProcessEnv = { ...file?.vars, ...env };

  const node = readNodeId(merged) ?? local.node;
  if (!node) {
    throw new Error(
      "set EBBGATE_NODE or write ~/.ebbgate/node (ebbgate agent install --node <id>)",
    );
  }
  const creds = readNodeCredentials({
    yamlText: readFileSync(configPath, "utf8"),
    configPath,
    node,
    env: merged,
    ...(envFilePath ? { envFile: envFilePath } : {}),
  });

  const dispatcherUrl = (
    merged.EBBGATE_DISPATCHER_URL ??
    local.dispatcherUrl ??
    DEFAULT_DISPATCHER_URL
  ).replace(/\/$/, "");

  const gatewayUrl = merged.EBBGATE_GATEWAY_URL ?? local.gatewayUrl ?? DEFAULT_GATEWAY_URL;
  const runnerPort = Number(merged.EBBGATE_RUNNER_PORT ?? local.runnerPort ?? 8787);
  const runnerHost = merged.EBBGATE_RUNNER_HOST ?? local.runnerHost ?? DEFAULT_RUNNER_HOST;
  const ollamaUrl = (
    merged.EBBGATE_OLLAMA_URL ??
    local.ollamaUrl ??
    "http://127.0.0.1:11434"
  ).replace(/\/$/, "");

  return {
    node,
    token: creds.token,
    dispatcherUrl,
    gatewayUrl,
    runnerPort,
    runnerHost,
    ollamaUrl,
    configPath,
    ...(envFilePath ? { envFile: envFilePath } : {}),
    ...(creds.statusToken ? { statusToken: creds.statusToken } : {}),
  };
}
