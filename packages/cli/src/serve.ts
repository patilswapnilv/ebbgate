import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { loadEnvFile } from "@ebbgate/agent";
// The side-effect-free entry: "@ebbgate/dispatcher" itself starts a server when it
// is the program being run, and the CLI bundle inlines it, so import /start only.
import { type DispatcherServer, runMain } from "@ebbgate/dispatcher/start";
import { SECRETS_FILE } from "./generate/secrets-file.js";

/**
 * `ebbgate serve`: start the dispatcher in this process, the one-command
 * replacement for `node --env-file=.env …/dispatcher/dist/index.js`.
 */

export const SERVE_EXIT = { OK: 0, ERROR: 1, USAGE: 2 } as const;

export interface ServeArgs {
  config?: string;
  envFile?: string;
}

export function parseServeArgs(args: string[]): ServeArgs {
  const out: ServeArgs = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = args[i + 1];
    const takeValue = (): string => {
      if (!next || next.startsWith("--")) throw new Error(`${a} needs a value`);
      i++;
      return next;
    };
    if (a === "--config" || a === "-c") out.config = takeValue();
    else if (a === "--env" || a === "--env-file") out.envFile = takeValue();
    else throw new Error(`unknown option: ${a}`);
  }
  return out;
}

export interface ResolvedServe {
  configPath: string;
  /** Absolute env-file path when one was found or given. */
  envFile?: string;
}

/**
 * Same lookup as `ebbgate doctor`: --config -> EBBGATE_CONFIG -> ./ebbgate.yaml ->
 * ~/.ebbgate/ebbgate.yaml; the env file: --env -> EBBGATE_ENV_FILE -> .env next to
 * the config. Explicit paths must exist; the implicit .env is optional.
 */
export function resolveServePaths(
  args: ServeArgs,
  env: NodeJS.ProcessEnv,
  cwd: string,
): ResolvedServe {
  let configPath: string | undefined;
  if (args.config) configPath = resolve(cwd, args.config);
  else if (env.EBBGATE_CONFIG) configPath = resolve(cwd, env.EBBGATE_CONFIG);
  else {
    const local = resolve(cwd, "ebbgate.yaml");
    const home = env.HOME ? resolve(env.HOME, ".ebbgate", "ebbgate.yaml") : undefined;
    configPath = existsSync(local) ? local : home && existsSync(home) ? home : undefined;
  }
  if (!configPath) {
    throw new Error("no ebbgate.yaml in this directory; run `ebbgate init` or pass --config");
  }
  if (!existsSync(configPath)) {
    throw new Error(`config not found: ${configPath}; run \`ebbgate init\` or fix --config`);
  }

  const explicitEnv = args.envFile ?? env.EBBGATE_ENV_FILE;
  if (explicitEnv) {
    const envFile = resolve(cwd, explicitEnv);
    if (!existsSync(envFile)) throw new Error(`env file not found: ${envFile}`);
    return { configPath, envFile };
  }
  const candidate = resolve(dirname(configPath), SECRETS_FILE);
  return existsSync(candidate) ? { configPath, envFile: candidate } : { configPath };
}

/** The URL the server actually listens on (port 0 resolves to the bound port). */
export function listenUrl(server: DispatcherServer): string {
  const addr = server.address() as AddressInfo | null;
  if (!addr || typeof addr === "string") return String(addr ?? "");
  const host = addr.family === "IPv6" ? `[${addr.address}]` : addr.address;
  return `http://${host}:${addr.port}`;
}

export interface ServeOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Human-readable lines (stderr by default, so stdout stays pino JSON logs). */
  write?: (line: string) => void;
  /** Signals that stop the server. Injectable so tests never touch the real process. */
  signals?: Pick<NodeJS.Process, "once" | "off">;
}

export interface ServeHandle {
  code: number;
  server?: DispatcherServer;
  /** Resolves with the exit code once the server has shut down. */
  done: Promise<number>;
}

/**
 * Load the env file and config, start the dispatcher, print where it listens, and
 * stop it cleanly on SIGINT/SIGTERM. Never prints a secret value: only paths and URLs.
 */
export async function startServe(args: string[], opts: ServeOptions = {}): Promise<ServeHandle> {
  const write = opts.write ?? ((line: string) => process.stderr.write(`${line}\n`));
  const baseEnv = opts.env ?? process.env;
  const cwd = resolve(opts.cwd ?? process.cwd());
  const fail = (code: number, message: string): ServeHandle => {
    write(`ebbgate serve: ${message}`);
    return { code, done: Promise.resolve(code) };
  };

  let parsed: ServeArgs;
  try {
    parsed = parseServeArgs(args);
  } catch (err) {
    return fail(
      SERVE_EXIT.USAGE,
      `${(err as Error).message}\nusage: ebbgate serve [--config PATH] [--env PATH]`,
    );
  }

  let paths: ResolvedServe;
  let fileVars: Record<string, string> = {};
  try {
    paths = resolveServePaths(parsed, baseEnv, cwd);
    if (paths.envFile) {
      const loaded = loadEnvFile(paths.envFile);
      if (loaded.warning) write(`warning: ${loaded.warning}`);
      fileVars = loaded.vars;
    }
  } catch (err) {
    return fail(SERVE_EXIT.ERROR, (err as Error).message);
  }

  // Like `node --env-file`: variables already in the environment win over the file.
  const env: NodeJS.ProcessEnv = { ...fileVars, ...baseEnv, EBBGATE_CONFIG: paths.configPath };
  // Relative EBBGATE_DB (default ./data/ebbgate.db) resolves against cwd, as before.
  if (env.EBBGATE_DB && !env.EBBGATE_DB.startsWith("file:") && env.EBBGATE_DB !== ":memory:") {
    env.EBBGATE_DB = resolve(cwd, env.EBBGATE_DB);
  } else if (!env.EBBGATE_DB) {
    env.EBBGATE_DB = resolve(cwd, "data", "ebbgate.db");
  }

  const result = await runMain(env, write);
  if (result.code !== 0) return { code: SERVE_EXIT.ERROR, done: Promise.resolve(SERVE_EXIT.ERROR) };
  const { server } = result;

  const url = listenUrl(server);
  write(`ebbgate dispatcher listening on ${url}`);
  write(`  config: ${paths.configPath}`);
  write(`  env:    ${paths.envFile ?? "(process environment only)"}`);
  write(`  Paperclip http adapter → ${url}/run`);
  write("  stop with Ctrl-C");

  const signals = opts.signals ?? process;
  const done = new Promise<number>((settle) => {
    const stop = (signal: NodeJS.Signals) => {
      for (const s of ["SIGINT", "SIGTERM"] as const) signals.off(s, stop);
      write(`ebbgate serve: ${signal} received, shutting down`);
      server.shutdown().then(
        () => settle(SERVE_EXIT.OK),
        (err: unknown) => {
          write(`ebbgate serve: shutdown failed: ${(err as Error)?.message ?? String(err)}`);
          settle(SERVE_EXIT.ERROR);
        },
      );
    };
    signals.once("SIGINT", stop);
    signals.once("SIGTERM", stop);
  });
  return { code: SERVE_EXIT.OK, server, done };
}

/** CLI entry: resolves with the exit code once the server has stopped. */
export async function runServeCommand(args: string[], opts: ServeOptions = {}): Promise<number> {
  const handle = await startServe(args, opts);
  return handle.done;
}
