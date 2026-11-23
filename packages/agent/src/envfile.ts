import { existsSync, readFileSync, statSync } from "node:fs";

const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Parse a dotenv-style file: `KEY=value` lines, optional `export ` prefix,
 * `#` comments, and single- or double-quoted values. Values are never
 * interpolated or evaluated.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const body = line.startsWith("export ") ? line.slice(7).trimStart() : line;
    const eq = body.indexOf("=");
    if (eq <= 0) continue;
    const key = body.slice(0, eq).trim();
    if (!KEY.test(key)) continue;
    let value = body.slice(eq + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length >= 2) {
      value = value.slice(1, -1);
    } else {
      const hash = value.search(/\s#/);
      if (hash >= 0) value = value.slice(0, hash).trimEnd();
    }
    out[key] = value;
  }
  return out;
}

export interface LoadedEnvFile {
  path: string;
  vars: Record<string, string>;
  /** Set when the file is readable by group or others (it holds secrets). */
  warning?: string;
}

/** Read an env file. Reports, but does not fail on, loose permissions. */
export function loadEnvFile(path: string): LoadedEnvFile {
  if (!existsSync(path)) throw new Error(`env file not found: ${path}`);
  const vars = parseEnvFile(readFileSync(path, "utf8"));
  const mode = statSync(path).mode & 0o777;
  const warning =
    (mode & 0o077) !== 0
      ? `env file ${path} is readable by other users (mode ${mode.toString(8)}); run: chmod 600 ${path}`
      : undefined;
  return { path, vars, ...(warning ? { warning } : {}) };
}
