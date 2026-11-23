#!/usr/bin/env node
import { isEntrypoint, runAgentCli } from "@ebbgate/agent";
import { runAdmit } from "./admit.js";
import { runDemoCommand } from "./demo.js";
import { runDoctorCommand } from "./doctor.js";
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
    const result = await runInit({
      yes,
      force,
      answers: {
        ...(node ? { nodes: [{ id: node, prefer: true }] } : {}),
        ...(publicUrl ? { publicUrl } : {}),
        ...(cloudRunner ? { cloudRunner } : {}),
        ...(paperclipApiUrl ? { paperclipApiUrl } : {}),
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

  if (cmd === "demo") {
    await runDemoCommand(argv.slice(1));
    return;
  }

  if (cmd === "help" || cmd === "--help" || cmd === "-h" || !cmd) {
    console.log(`ebbgate — presence-aware task dispatcher for Paperclip agents

Usage:
  ebbgate demo [--fast]          60-second simulation, no setup needed
  ebbgate init [--yes] [--force] [--node ID] [--public-url URL] [--cloud-runner URL]
               [--paperclip-url URL]
                                 write ebbgate.yaml + .env (secrets, mode 600)
  ebbgate doctor [--json] [--config PATH]
                                 check the setup; exit 1 on any failure
  ebbgate admit --node <id> | --remote [--agent <id>] [--private]
                                 admission probe (exit 0 admit, non-zero refuse)
  ebbgate agent install [--node ID]   macOS launchd presence agent (uninstall|run)
  ebbgate busy on|off|auto
  ebbgate status
  ebbgate runner
`);
    return;
  }

  // Delegate local node commands to @ebbgate/agent
  await runAgentCli(argv);
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
