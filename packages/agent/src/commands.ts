import { resolve } from "node:path";
import { loadAgentRuntime } from "./config.js";
import { runDaemon } from "./daemon.js";
import { installAgent, uninstallAgent } from "./install.js";
import { busyArgToMode, writeMode } from "./mode.js";
import { DEFAULT_RUNNER_PORT } from "./paths.js";
import { startRunnerShim } from "./runner.js";
import { printStatus } from "./status.js";

export async function main(argv: string[]): Promise<void> {
  const [cmd, sub, ...rest] = argv;

  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    printHelp();
    return;
  }

  if (cmd === "agent") {
    if (sub === "install") {
      const opts = parseFlags(rest);
      const node = opts.node ?? process.env.EBBGATE_NODE;
      if (!node) {
        throw new Error("ebbgate agent install requires --node <id>");
      }
      const result = await installAgent({
        node,
        ...(opts.dispatcher ? { dispatcherUrl: opts.dispatcher } : {}),
        ...(opts.gateway ? { gatewayUrl: opts.gateway } : {}),
        ...(opts.config ? { configPath: resolve(opts.config) } : {}),
        ...(opts.runnerHost ? { runnerHost: opts.runnerHost } : {}),
        ...(opts.envFile ? { envFile: resolve(opts.envFile) } : {}),
      });
      console.log(`installed launch agent → ${result.plistPath}`);
      console.log(`node=${node}`);
      return;
    }
    if (sub === "uninstall") {
      await uninstallAgent({});
      console.log("uninstalled launch agent");
      return;
    }
    if (sub === "run") {
      const config = loadAgentRuntime();
      console.error(`ebbgate agent running for node=${config.node} → ${config.dispatcherUrl}`);
      await runDaemon({ config });
      return;
    }
    throw new Error("usage: ebbgate agent install|uninstall|run");
  }

  if (cmd === "busy") {
    if (!sub) throw new Error("usage: ebbgate busy on|off|auto");
    const mode = busyArgToMode(sub);
    writeMode(mode);
    console.log(`mode=${mode}`);
    return;
  }

  if (cmd === "status") {
    console.log(await printStatus());
    return;
  }

  if (cmd === "runner") {
    const config = loadAgentRuntime();
    const port = Number(
      process.env.EBBGATE_RUNNER_PORT ?? config.runnerPort ?? DEFAULT_RUNNER_PORT,
    );
    const server = await startRunnerShim({
      port,
      host: config.runnerHost,
      gatewayUrl: config.gatewayUrl,
    });
    console.error(
      `ebbgate runner listening on ${config.runnerHost}:${port} → ${config.gatewayUrl}`,
    );
    if (isLoopback(config.runnerHost)) {
      console.error(
        "ebbgate runner: bound to loopback; a dispatcher on another machine cannot reach it. " +
          "Set EBBGATE_RUNNER_HOST (e.g. your VPN/Tailscale IP or 0.0.0.0).",
      );
    }
    await new Promise<void>((resolvePromise) => {
      server.on("close", () => resolvePromise());
    });
    return;
  }

  throw new Error(`unknown command: ${cmd}\n\n${helpText()}`);
}

/** True for addresses only reachable from this machine. */
export function isLoopback(host: string): boolean {
  return host === "localhost" || host === "::1" || host.startsWith("127.");
}

function parseFlags(args: string[]): {
  node?: string;
  dispatcher?: string;
  gateway?: string;
  config?: string;
  runnerHost?: string;
  envFile?: string;
} {
  const out: {
    node?: string;
    dispatcher?: string;
    gateway?: string;
    config?: string;
    runnerHost?: string;
    envFile?: string;
  } = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = args[i + 1];
    if (a === "--node" && next) {
      out.node = next;
      i++;
    } else if (a === "--dispatcher" && next) {
      out.dispatcher = next;
      i++;
    } else if (a === "--gateway" && next) {
      out.gateway = next;
      i++;
    } else if (a === "--env-file" && next) {
      out.envFile = next;
      i++;
    } else if (a === "--runner-host" && next) {
      out.runnerHost = next;
      i++;
    } else if (a === "--config" && next) {
      out.config = next;
      i++;
    }
  }
  return out;
}

function helpText(): string {
  return `ebbgate — local presence agent and runner shim

Usage:
  ebbgate agent install --node <id> [--dispatcher URL] [--gateway URL] [--config PATH]
                        [--runner-host HOST] [--env-file PATH]
  ebbgate agent uninstall
  ebbgate agent run
  ebbgate busy on|off|auto
  ebbgate status
  ebbgate runner
`;
}

function printHelp(): void {
  console.log(helpText());
}
