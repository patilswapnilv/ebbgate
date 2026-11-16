import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "@ebbgate/core";
import { createApp } from "./app.js";
import { openDb } from "./db/index.js";
import { createLogger } from "./logger.js";
import { createHttpPaperclipClient } from "./paperclip/client.js";
import { listen } from "./serve.js";

export { createApp } from "./app.js";
export { openDb } from "./db/index.js";
export { createHttpPaperclipClient } from "./paperclip/client.js";
export { ParseError, parseRun } from "./paperclip/parse.js";
export type { PaperclipClient, TaskContextInput } from "./paperclip/types.js";
export { listen } from "./serve.js";

async function main(): Promise<void> {
  const configPath = resolve(process.env.EBBGATE_CONFIG ?? "ebbgate.yaml");
  const yamlText = readFileSync(configPath, "utf8");
  const config = loadConfig(yamlText, process.env);
  const logger = createLogger(process.env.LOG_LEVEL ?? "info");

  const dbPath = resolve(process.env.EBBGATE_DB ?? "./data/ebbgate.db");
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

  await listen(app, config.server.port);
  logger.info({ port: config.server.port }, "ebbgate dispatcher listening");
}

const isMain =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("/index.js") ||
    process.argv[1].endsWith("/dispatcher/src/index.ts") ||
    process.argv[1].includes("@ebbgate/dispatcher"));

if (isMain) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
