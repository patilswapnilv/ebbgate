import { parse as parseYaml } from "yaml";

const ENV_REF = /\$\{([A-Z_][A-Z0-9_]*)\}/g;

export interface NodeCredentials {
  token: string;
  /**
   * Optional dispatcher admin secret for `ebbgate status`. Only present when its
   * env vars happen to be set; a node never needs it to run.
   */
  statusToken?: string;
}

/** Variables a string references with `${VAR}`. */
export function referencedVars(value: string): string[] {
  return [...value.matchAll(ENV_REF)].map((m) => m[1] as string);
}

function interpolate(value: string, env: Record<string, string | undefined>): string {
  return value.replace(ENV_REF, (_, name: string) => env[name] ?? "");
}

/**
 * Read only what a node needs from ebbgate.yaml: its own token. Unlike the
 * dispatcher's loadConfig, this does not require every secret referenced in the
 * file (Paperclip key, notifier tokens, other nodes' tokens), so a node holds
 * nothing but its own credential. Errors name variables and paths, never values.
 */
export function readNodeCredentials(args: {
  yamlText: string;
  configPath: string;
  node: string;
  env: Record<string, string | undefined>;
  envFile?: string;
}): NodeCredentials {
  const { configPath, node, env } = args;
  let doc: unknown;
  try {
    doc = parseYaml(args.yamlText, { prettyErrors: false });
  } catch (err) {
    const e = err as { code?: unknown; linePos?: Array<{ line?: number; col?: number }> };
    const pos = e?.linePos?.[0];
    const where = pos?.line ? ` at line ${pos.line}, column ${pos.col}` : "";
    throw new Error(
      `YAML parse error (${String(e?.code ?? "SYNTAX_ERROR")})${where} in ${configPath}`,
    );
  }

  const root = (doc ?? {}) as {
    nodes?: Record<string, { token?: unknown }>;
    paperclip?: { sharedSecret?: unknown };
  };
  const entry = root.nodes?.[node];
  if (!entry) throw new Error(`node "${node}" is not in ${configPath}`);
  if (typeof entry.token !== "string" || entry.token.length === 0) {
    throw new Error(`nodes.${node}.token is missing in ${configPath}`);
  }

  const missing = referencedVars(entry.token).filter((v) => !env[v]);
  if (missing.length > 0) {
    const where = args.envFile
      ? `the environment or ${args.envFile}`
      : "the environment, or an env file (--env-file / EBBGATE_ENV_FILE / ~/.ebbgate/.env)";
    throw new Error(`node "${node}" needs ${missing.join(", ")}: set it in ${where}`);
  }
  const token = interpolate(entry.token, env);
  if (token.length < 16) {
    throw new Error(`nodes.${node}.token must be at least 16 characters`);
  }

  const shared = root.paperclip?.sharedSecret;
  let statusToken: string | undefined;
  if (typeof shared === "string" && referencedVars(shared).every((v) => env[v])) {
    const value = interpolate(shared, env);
    if (value) statusToken = value;
  }
  return { token, ...(statusToken ? { statusToken } : {}) };
}
