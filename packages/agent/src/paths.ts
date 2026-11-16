import { homedir } from "node:os";
import { join } from "node:path";

export const EBBGATE_DIR = join(homedir(), ".ebbgate");
export const MODE_FILE = join(EBBGATE_DIR, "mode");
export const NODE_FILE = join(EBBGATE_DIR, "node");
export const AGENT_CONFIG_FILE = join(EBBGATE_DIR, "agent.json");
export const LAUNCH_AGENT_LABEL = "dev.ebbgate.agent";
export const LAUNCH_AGENT_PLIST = join(
  homedir(),
  "Library",
  "LaunchAgents",
  `${LAUNCH_AGENT_LABEL}.plist`,
);

export const DEFAULT_INTERVAL_MS = 30_000;
export const DEFAULT_RUNNER_PORT = 8787;
/** TODO(verify-paperclip): confirm local OpenClaw http adapter path. */
export const DEFAULT_GATEWAY_URL = "http://127.0.0.1:18789/paperclip";
export const DEFAULT_DISPATCHER_URL = "http://127.0.0.1:8790";
export const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";
export const AGENT_VERSION = "0.0.0";
