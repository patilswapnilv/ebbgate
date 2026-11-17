import { execFile } from "node:child_process";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  type AgentLocalFile,
  readAgentLocalFile,
  resolveConfigPath,
  writeAgentLocalFile,
  writeNodeId,
} from "./config.js";
import {
  DEFAULT_DISPATCHER_URL,
  DEFAULT_GATEWAY_URL,
  DEFAULT_OLLAMA_URL,
  DEFAULT_RUNNER_HOST,
  DEFAULT_RUNNER_PORT,
  EBBGATE_DIR,
  LAUNCH_AGENT_LABEL,
  LAUNCH_AGENT_PLIST,
} from "./paths.js";

const execFileAsync = promisify(execFile);

export interface InstallOptions {
  node: string;
  dispatcherUrl?: string;
  gatewayUrl?: string;
  configPath?: string;
  runnerHost?: string;
  /** Absolute path to the node binary that should run the CLI. */
  nodeBin?: string;
  /** Absolute path to packages/agent/dist/cli.js */
  cliPath?: string;
  plistPath?: string;
  exec?: typeof execFileAsync;
  env?: NodeJS.ProcessEnv;
}

export function defaultCliPath(): string {
  // Prefer built cli next to this module when running from dist/.
  return fileURLToPath(new URL("./cli.js", import.meta.url));
}

/** Everything the installed daemon needs, resolved once at install time. */
export interface InstallSettings {
  configPath: string;
  dispatcherUrl: string;
  gatewayUrl: string;
  ollamaUrl: string;
  runnerHost: string;
  runnerPort: number;
}

/**
 * Resolve the settings to persist. Precedence for each value:
 * explicit option -> installing shell's environment -> existing local file -> default.
 * The config path is made absolute, so launchd never depends on the shell's cwd.
 */
export function resolveInstallSettings(
  opts: Pick<InstallOptions, "configPath" | "dispatcherUrl" | "gatewayUrl" | "runnerHost">,
  env: NodeJS.ProcessEnv,
  local: AgentLocalFile,
): InstallSettings {
  const configPath = opts.configPath ? resolve(opts.configPath) : resolveConfigPath(env, local); // EBBGATE_CONFIG -> saved path -> ./ebbgate.yaml -> ~/.ebbgate
  return {
    configPath,
    dispatcherUrl: (
      opts.dispatcherUrl ??
      env.EBBGATE_DISPATCHER_URL ??
      local.dispatcherUrl ??
      DEFAULT_DISPATCHER_URL
    ).replace(/\/$/, ""),
    gatewayUrl:
      opts.gatewayUrl ?? env.EBBGATE_GATEWAY_URL ?? local.gatewayUrl ?? DEFAULT_GATEWAY_URL,
    ollamaUrl: (env.EBBGATE_OLLAMA_URL ?? local.ollamaUrl ?? DEFAULT_OLLAMA_URL).replace(/\/$/, ""),
    runnerHost:
      opts.runnerHost ?? env.EBBGATE_RUNNER_HOST ?? local.runnerHost ?? DEFAULT_RUNNER_HOST,
    runnerPort: Number(env.EBBGATE_RUNNER_PORT ?? local.runnerPort ?? DEFAULT_RUNNER_PORT),
  };
}

/** Environment the launchd job runs with: every resolved setting, explicitly. */
export function launchAgentEnv(
  node: string,
  settings: InstallSettings,
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  const vars: Record<string, string> = {
    EBBGATE_NODE: node,
    EBBGATE_CONFIG: settings.configPath,
    EBBGATE_DISPATCHER_URL: settings.dispatcherUrl,
    EBBGATE_GATEWAY_URL: settings.gatewayUrl,
    EBBGATE_OLLAMA_URL: settings.ollamaUrl,
    EBBGATE_RUNNER_HOST: settings.runnerHost,
    EBBGATE_RUNNER_PORT: String(settings.runnerPort),
    PATH: env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
  };
  if (env.HOME) vars.HOME = env.HOME;
  return vars;
}

/** The plist the installer writes: resolved settings, explicit env, fixed working directory. */
export function buildLaunchAgentPlist(args: {
  node: string;
  settings: InstallSettings;
  env: NodeJS.ProcessEnv;
  nodeBin: string;
  cliPath: string;
}): string {
  return renderLaunchAgentPlist({
    label: LAUNCH_AGENT_LABEL,
    nodeBin: args.nodeBin,
    cliPath: args.cliPath,
    env: launchAgentEnv(args.node, args.settings, args.env),
    workingDirectory: EBBGATE_DIR,
  });
}

export function renderLaunchAgentPlist(args: {
  label: string;
  nodeBin: string;
  cliPath: string;
  env: Record<string, string>;
  workingDirectory?: string;
}): string {
  const envEntries = Object.entries(args.env)
    .map(([k, v]) => `    <key>${escapeXml(k)}</key>\n    <string>${escapeXml(v)}</string>`)
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(args.label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(args.nodeBin)}</string>
    <string>${escapeXml(args.cliPath)}</string>
    <string>agent</string>
    <string>run</string>
  </array>
${args.workingDirectory ? `  <key>WorkingDirectory</key>\n  <string>${escapeXml(args.workingDirectory)}</string>\n` : ""}  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
${envEntries}
  </dict>
  <key>StandardOutPath</key>
  <string>/tmp/ebbgate-agent.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/ebbgate-agent.err.log</string>
</dict>
</plist>
`;
}

function escapeXml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export async function installAgent(opts: InstallOptions): Promise<{ plistPath: string }> {
  const exec = opts.exec ?? execFileAsync;
  const plistPath = opts.plistPath ?? LAUNCH_AGENT_PLIST;
  const nodeBin = opts.nodeBin ?? process.execPath;
  const cliPath = opts.cliPath ?? defaultCliPath();
  const env = opts.env ?? process.env;

  const local = readAgentLocalFile();
  // Resolve before writing anything: fails early (no half-install) if no config exists.
  const settings = resolveInstallSettings(opts, env, local);

  writeNodeId(opts.node);
  writeAgentLocalFile({ ...local, node: opts.node, ...settings });

  const xml = buildLaunchAgentPlist({ node: opts.node, settings, env, nodeBin, cliPath });

  mkdirSync(EBBGATE_DIR, { recursive: true });
  mkdirSync(dirname(plistPath), { recursive: true });
  writeFileSync(plistPath, xml, { mode: 0o644 });

  // Unload first if present, then load.
  try {
    await exec("launchctl", ["bootout", `gui/${process.getuid?.() ?? 501}/${LAUNCH_AGENT_LABEL}`]);
  } catch {
    try {
      await exec("launchctl", ["unload", plistPath]);
    } catch {
      // not loaded
    }
  }
  try {
    await exec("launchctl", ["bootstrap", `gui/${process.getuid?.() ?? 501}`, plistPath]);
  } catch {
    await exec("launchctl", ["load", plistPath]);
  }

  return { plistPath };
}

export async function uninstallAgent(opts: {
  plistPath?: string;
  exec?: typeof execFileAsync;
}): Promise<void> {
  const exec = opts.exec ?? execFileAsync;
  const plistPath = opts.plistPath ?? LAUNCH_AGENT_PLIST;
  try {
    await exec("launchctl", ["bootout", `gui/${process.getuid?.() ?? 501}/${LAUNCH_AGENT_LABEL}`]);
  } catch {
    try {
      await exec("launchctl", ["unload", plistPath]);
    } catch {
      // ignore
    }
  }
  try {
    unlinkSync(plistPath);
  } catch {
    // already gone
  }
}
