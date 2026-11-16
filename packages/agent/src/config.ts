import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { type EbbgateConfig, loadConfig } from "@ebbgate/core";
import {
  AGENT_CONFIG_FILE,
  DEFAULT_DISPATCHER_URL,
  DEFAULT_GATEWAY_URL,
  EBBGATE_DIR,
  NODE_FILE,
} from "./paths.js";

export interface AgentRuntimeConfig {
  node: string;
  token: string;
  dispatcherUrl: string;
  gatewayUrl: string;
  runnerPort: number;
  ollamaUrl: string;
  /** Absolute path to the ebbgate.yaml used for tokens / nodes. */
  configPath: string;
  ebbgate: EbbgateConfig;
}

export interface AgentLocalFile {
  node?: string;
  dispatcherUrl?: string;
  gatewayUrl?: string;
  runnerPort?: number;
  ollamaUrl?: string;
  configPath?: string;
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
  if (env.EBBGATE_CONFIG) return resolve(env.EBBGATE_CONFIG);
  if (local.configPath) return resolve(local.configPath);
  const cwd = resolve("ebbgate.yaml");
  if (existsSync(cwd)) return cwd;
  const home = resolve(EBBGATE_DIR, "ebbgate.yaml");
  if (existsSync(home)) return home;
  throw new Error(
    "no ebbgate.yaml found; set EBBGATE_CONFIG or place ebbgate.yaml in cwd / ~/.ebbgate/",
  );
}

export function loadAgentRuntime(env: NodeJS.ProcessEnv = process.env): AgentRuntimeConfig {
  const local = readAgentLocalFile();
  const configPath = resolveConfigPath(env, local);
  const ebbgate = loadConfig(readFileSync(configPath, "utf8"), env);

  const node = readNodeId(env) ?? local.node;
  if (!node) {
    throw new Error(
      "set EBBGATE_NODE or write ~/.ebbgate/node (ebbgate agent install --node <id>)",
    );
  }
  const nodeCfg = ebbgate.nodes[node];
  if (!nodeCfg) {
    throw new Error(`node "${node}" is not in ${configPath}`);
  }

  const dispatcherUrl = (
    env.EBBGATE_DISPATCHER_URL ??
    local.dispatcherUrl ??
    DEFAULT_DISPATCHER_URL
  ).replace(/\/$/, "");

  const gatewayUrl = env.EBBGATE_GATEWAY_URL ?? local.gatewayUrl ?? DEFAULT_GATEWAY_URL;
  const runnerPort = Number(env.EBBGATE_RUNNER_PORT ?? local.runnerPort ?? 8787);
  const ollamaUrl = (env.EBBGATE_OLLAMA_URL ?? local.ollamaUrl ?? "http://127.0.0.1:11434").replace(
    /\/$/,
    "",
  );

  return {
    node,
    token: nodeCfg.token,
    dispatcherUrl,
    gatewayUrl,
    runnerPort,
    ollamaUrl,
    configPath,
    ebbgate,
  };
}
