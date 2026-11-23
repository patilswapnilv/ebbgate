#!/usr/bin/env node
import { isEntrypoint, runAgentCli } from "@ebbgate/agent";
import { runAdmit } from "./admit.js";
import { runDemoCommand } from "./demo.js";
import { runDoctorCommand } from "./doctor.js";
import { runDecisions, runStatusCommand, runWhy } from "./explain.js";
import { runInit } from "./init.js";

async function main(argv: string[]): Promise<void> {
  // Run in the directory the user invoked from. Via `pnpm ebbgate ...` the script
  // runs in the repo root, and pnpm/npm record the caller's directory in INIT_CWD.
  if (process.env.INIT_CWD && process.env.INIT_CWD !== process.cwd()) {
    process.chdir(process.env.INIT_CWD);
  }

  const [cmd] = argv;

  if (cmd === "init") {
    const args = argv.slice(1);
    const yes = args.includes("--yes") || args.includes("-y");
    const force = args.includes("--force");
    const node = flag(args, "--node");
    const publicUrl = flag(args, "--public-url");
    const cloudRunner = flag(args, "--cloud-runner");
    const paperclipApiUrl = flag(args, "--paperclip-url");
    const model = flag(args, "--model");
    const result = await runInit({
      yes,
      force,
      ollama: ollamaMode(args, yes),
      answers: {
        ...(node ? { nodes: [{ id: node, prefer: true }] } : {}),
        ...(publicUrl ? { publicUrl } : {}),
        ...(cloudRunner ? { cloudRunner } : {}),
        ...(paperclipApiUrl ? { paperclipApiUrl } : {}),
        ...(model ? { model } : {}),
      },
    });
    if (yes) {
      // Secrets stay in the 0600 file; the summary masks them.
      console.log(`wrote:\n${result.files.map((f) => `  ${f}`).join("\n")}\n`);
      console.log(result.summary);
    }
    return;
  }

  if (cmd === "doctor") {
    process.exitCode = await runDoctorCommand(argv.slice(1));
    return;
  }

  if (cmd === "admit") {
    process.exitCode = await runAdmit(argv.slice(1));
    return;
  }

  if (cmd === "status") {
    process.exitCode = await runStatusCommand(argv.slice(1));
    return;
  }

  if (cmd === "why") {
    process.exitCode = await runWhy(argv.slice(1));
    return;
  }

  if (cmd === "decisions") {
    process.exitCode = await runDecisions(argv.slice(1));
    return;
  }

  if (cmd === "demo") {
    await runDemoCommand(argv.slice(1));
    return;
  }

  if (cmd === "help" || cmd === "--help" || cmd === "-h" || !cmd) {
    console.log(`ebbgate — presence-aware task dispatcher for Paperclip agents

Usage:
  ebbgate demo [--fast]          60-second simulation, no setup needed
  ebbgate init [--yes] [--force] [--node ID] [--public-url URL] [--cloud-runner URL]
               [--paperclip-url URL] [--model NAME] [--no-ollama]
                                 write ebbgate.yaml + .env (secrets, mode 600); offers to
                                 install Ollama and pull a small model (--yes accepts)
  ebbgate doctor [--json] [--config PATH]
                                 check the setup; exit 1 on any failure
  ebbgate admit --node <id> | --remote [--agent <id>] [--private]
                                 admission probe (exit 0 admit, non-zero refuse)
  ebbgate agent install [--node ID]   macOS launchd presence agent (uninstall|run)
  ebbgate busy on|off|auto
  ebbgate status [--json]        presence, queue, and why each waiting task waits
  ebbgate why <taskId> [--json]  every routing decision for a task, and why
  ebbgate decisions [--task ID] [--agent ID] [--kind route|admission] [--limit N] [--json]
                                 the decision audit log, newest first
  ebbgate runner
`);
    return;
  }

  // Delegate local node commands to @ebbgate/agent
  await runAgentCli(argv);
}

/**
 * Ollama setup: --no-ollama skips, --yes accepts (except a remote install script,
 * which always needs an interactive yes), a terminal asks, and anything else
 * (pipes, CI) skips with a message.
 */
export function ollamaMode(
  args: string[],
  yes: boolean,
  interactive: boolean = Boolean(process.stdin.isTTY && process.stdout.isTTY) && !process.env.CI,
): { mode: "ask" | "accept" | "skip"; skipReason?: string } {
  if (args.includes("--no-ollama")) {
    return { mode: "skip", skipReason: "Skipping Ollama setup (--no-ollama)." };
  }
  if (yes) return { mode: "accept" };
  if (interactive) return { mode: "ask" };
  return {
    mode: "skip",
    skipReason:
      "Not an interactive terminal, so init won't install anything. Re-run with --yes to accept.",
  };
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  const v = i >= 0 ? args[i + 1] : undefined;
  return v && !v.startsWith("--") ? v : undefined;
}

if (isEntrypoint(import.meta.url)) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

export { main };
