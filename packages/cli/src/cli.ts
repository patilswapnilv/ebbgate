#!/usr/bin/env node
import { isEntrypoint, runAgentCli } from "@ebbgate/agent";
import { runAdmit } from "./admit.js";
import { runDemoCommand } from "./demo.js";
import { runInit } from "./init.js";

async function main(argv: string[]): Promise<void> {
  // Run in the directory the user invoked from. Via `pnpm ebbgate ...` the script
  // runs in the repo root, and pnpm/npm record the caller's directory in INIT_CWD.
  if (process.env.INIT_CWD && process.env.INIT_CWD !== process.cwd()) {
    process.chdir(process.env.INIT_CWD);
  }

  const [cmd] = argv;

  if (cmd === "init") {
    const yes = argv.includes("--yes") || argv.includes("-y");
    const force = argv.includes("--force");
    const result = await runInit({ yes, force });
    if (yes) {
      console.log(`wrote:\n${result.files.map((f) => `  ${f}`).join("\n")}`);
      console.log(
        `\nPaperclip http adapter URL: ${result.answers.publicUrl.replace(/\/$/, "")}/run`,
      );
      console.log(`EG_PAPERCLIP_SECRET=${result.sharedSecret}`);
      for (const [k, v] of Object.entries(result.nodeSecrets)) {
        console.log(`${k}=${v}`);
      }
    }
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
  ebbgate init [--yes] [--force]
  ebbgate admit --node <id> | --remote [--agent <id>] [--private]
                                 admission probe (exit 0 admit, non-zero refuse)
  ebbgate agent install|uninstall|run
  ebbgate busy on|off|auto
  ebbgate status
  ebbgate runner
`);
    return;
  }

  // Delegate local node commands to @ebbgate/agent
  await runAgentCli(argv);
}

if (isEntrypoint(import.meta.url)) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

export { main };
