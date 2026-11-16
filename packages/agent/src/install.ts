import { execFile } from "node:child_process";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { readAgentLocalFile, writeAgentLocalFile, writeNodeId } from "./config.js";
import { LAUNCH_AGENT_LABEL, LAUNCH_AGENT_PLIST } from "./paths.js";

const execFileAsync = promisify(execFile);

export interface InstallOptions {
  node: string;
  dispatcherUrl?: string;
  gatewayUrl?: string;
  configPath?: string;
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

export function renderLaunchAgentPlist(args: {
  label: string;
  nodeBin: string;
  cliPath: string;
  env: Record<string, string>;
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
  <key>RunAtLoad</key>
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

  writeNodeId(opts.node);
  const local = readAgentLocalFile();
  writeAgentLocalFile({
    ...local,
    node: opts.node,
    ...(opts.dispatcherUrl ? { dispatcherUrl: opts.dispatcherUrl } : {}),
    ...(opts.gatewayUrl ? { gatewayUrl: opts.gatewayUrl } : {}),
    ...(opts.configPath ? { configPath: opts.configPath } : {}),
  });

  const envVars: Record<string, string> = {
    EBBGATE_NODE: opts.node,
    PATH: env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
  };
  if (opts.dispatcherUrl) envVars.EBBGATE_DISPATCHER_URL = opts.dispatcherUrl;
  if (opts.gatewayUrl) envVars.EBBGATE_GATEWAY_URL = opts.gatewayUrl;
  if (opts.configPath) envVars.EBBGATE_CONFIG = opts.configPath;
  if (env.HOME) envVars.HOME = env.HOME;

  const xml = renderLaunchAgentPlist({
    label: LAUNCH_AGENT_LABEL,
    nodeBin,
    cliPath,
    env: envVars,
  });

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
