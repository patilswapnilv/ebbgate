// The side-effect-free start API. `index.ts` re-exports this and also runs the
// server when executed directly; bundlers (the `ebbgate` CLI) import this module
// instead, so importing it never starts anything.
import { mkdirSync, readFileSync } from "node:fs";
import type { Server } from "node:http";
import { dirname, resolve } from "node:path";
import { loadConfig } from "@ebbgate/core";
import { createApp } from "./app.js";
import { openDb } from "./db/index.js";
import { createLogger } from "./logger.js";
import { createHttpPaperclipClient } from "./paperclip/client.js";
import { listen } from "./serve.js";

/** Create the database's parent directory so SQLite can create the file. */
export function ensureDbDir(dbPath: string): void {
  if (dbPath === ":memory:" || dbPath.startsWith("file:")) return;
  mkdirSync(dirname(dbPath), { recursive: true });
}

/** A listening dispatcher. `shutdown()` stops it gracefully (idempotent). */
export type DispatcherServer = Server & { shutdown(): Promise<void> };

/** Start the dispatcher from an environment. Resolves once it is listening. */
export async function startDispatcher(
  env: NodeJS.ProcessEnv = process.env,
): Promise<DispatcherServer> {
  const configPath = resolve(env.EBBGATE_CONFIG ?? "ebbgate.yaml");
  const config = loadConfig(readFileSync(configPath, "utf8"), env);
  const logger = createLogger(env.LOG_LEVEL ?? "info");

  const dbPath = resolve(env.EBBGATE_DB ?? "./data/ebbgate.db");
  ensureDbDir(dbPath);
  const db = openDb(dbPath);

  const paperclip = createHttpPaperclipClient({
    apiUrl: config.paperclip.apiUrl,
    apiKey: config.paperclip.apiKey,
  });

  const { app, tick, presence } = createApp({ config, db, paperclip, logger });

  // Close out runs a previous process left in flight, then replay every
  // interruption it did not finish recovering. Must finish before we listen.
  await presence.reconcileAfterRestart();

  const ticker = setInterval(() => {
    void tick().catch((err: unknown) => {
      logger.warn({ err: String(err) }, "presence tick failed");
    });
  }, 5_000);
  ticker.unref?.();

  const server = await listen(app, {
    port: config.server.port,
    host: config.server.host,
    maxBodyBytes: config.server.maxBodyBytes,
  });
  server.on("close", () => clearInterval(ticker));

  // Graceful shutdown: stop the ticker and new connections, let in-flight drains
  // and requests finish within the grace period, hand any deferred-queue claims
  // back, then close the database (WAL is checkpointed on close).
  const graceMs = config.queue.shutdownGraceSeconds * 1000;
  let stopping: Promise<void> | null = null;
  const shutdown = (): Promise<void> => {
    stopping ??= (async () => {
      clearInterval(ticker);
      const closed = new Promise<void>((done) => server.close(() => done()));
      server.closeIdleConnections();
      await presence.shutdown({ graceMs });
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        closed,
        new Promise<void>((done) => {
          timer = setTimeout(done, graceMs);
        }),
      ]);
      if (timer) clearTimeout(timer);
      server.closeAllConnections();
      db.close();
      logger.info("ebbgate dispatcher stopped");
    })();
    return stopping;
  };

  logger.info(
    { host: config.server.host, port: config.server.port },
    "ebbgate dispatcher listening",
  );
  return Object.assign(server, { shutdown });
}

/**
 * Startup errors print the message only (no stack, no parser internals). Config
 * errors are written without quoting config content, so no secret can leak here.
 */
export function formatStartupError(err: unknown): string {
  if (err instanceof Error) return `ebbgate: ${err.message}`;
  return "ebbgate: startup failed";
}

/**
 * The process entrypoint: start, or print a safe one-line error and return exit
 * code 1. `writeErr` is injectable so tests can capture exactly what reaches stderr.
 */
export async function runMain(
  env: NodeJS.ProcessEnv = process.env,
  writeErr: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): Promise<{ code: 0; server: DispatcherServer } | { code: 1 }> {
  try {
    return { code: 0, server: await startDispatcher(env) };
  } catch (err) {
    writeErr(formatStartupError(err));
    return { code: 1 };
  }
}
