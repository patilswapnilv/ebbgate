#!/usr/bin/env node
import { main } from "./commands.js";
import { isEntrypoint } from "./entrypoint.js";

export { main };

if (isEntrypoint(import.meta.url)) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
