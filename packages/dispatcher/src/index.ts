import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadConfig } from "@ebbgate/core";
import { createApp } from "./app.js";
import { openDb } from "./db/index.js";
import { createLogger } from "./logger.js";
import { isEntrypoint } from "./main.js";
import { createHttpPaperclipClient } from "./paperclip/client.js";
import { listen } from "./serve.js";

export { createApp } from "./app.js";
export { openDb } from "./db/index.js";
export { isEntrypoint } from "./main.js";
export { createHttpPaperclipClient } from "./paperclip/client.js";
export { ParseError, parseRun } from "./paperclip/parse.js";
export type { PaperclipClient, TaskContextInput } from "./paperclip/types.js";
export { listen } from "./serve.js";

/** Create the database's parent directory so SQLite can create the file. */
export function ensureDbDir(dbPath: string): void {
  if (dbPath === ":memory:" || dbPath.startsWith("file:")) return;
  mkdirSync(dirname(dbPath), { recursive: true });
}

async function main(): Promise<void> {
  const configPath = resolve(process.env.EBBGATE_CONFIG ?? "ebbgate.yaml");
  const config = loadConfig(readFileSync(configPath, "utf8"), process.env);
  const logger = createLogger(process.env.LOG_LEVEL ?? "info");

  const dbPath = resolve(process.env.EBBGATE_DB ?? "./data/ebbgate.db");
  ensureDbDir(dbPath);
  const db = openDb(dbPath);

  const paperclip = createHttpPaperclipClient({
    apiUrl: config.paperclip.apiUrl,
    apiKey: config.paperclip.apiKey,
  });

  const { app, tick } = createApp({ config, db, paperclip, logger });

  const ticker = setInterval(() => {
    void tick().catch((err: unknown) => {
      logger.warn({ err: String(err) }, "presence tick failed");
    });
  }, 5_000);
  ticker.unref?.();

  await listen(app, {
    port: config.server.port,
    host: config.server.host,
    maxBodyBytes: config.server.maxBodyBytes,
  });
  logger.info(
    { host: config.server.host, port: config.server.port },
    "ebbgate dispatcher listening",
  );
}

if (isEntrypoint(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
