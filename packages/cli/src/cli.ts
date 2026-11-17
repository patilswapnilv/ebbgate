#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runAgentCli } from "@ebbgate/agent";
import { runInit } from "./init.js";

async function main(argv: string[]): Promise<void> {
  const [cmd] = argv;

  if (cmd === "init") {
    const yes = argv.includes("--yes") || argv.includes("-y");
    const result = await runInit({ yes });
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

  if (cmd === "help" || cmd === "--help" || cmd === "-h" || !cmd) {
    console.log(`ebbgate — presence-aware task dispatcher for Paperclip agents

Usage:
  ebbgate init [--yes]
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

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

export { main };
