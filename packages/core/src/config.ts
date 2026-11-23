import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { TIERS } from "./types.js";

/* ------------------------------------------------------------------ */
/* Schema                                                              */
/* ------------------------------------------------------------------ */

const nodeIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,31}$/, "node ids must be lowercase letters, digits or dashes");

const tierSchema = z.enum(TIERS as unknown as ["private", "internal", "public"]);

const actionSchema = z.enum(["local", "local-low", "cloud", "defer"]);
const offlineActionSchema = z.enum(["cloud", "defer"], {
  message: "the offline action must be 'cloud' or 'defer' (no local node is reachable)",
});

const actionsSchema = z.object({
  available: actionSchema,
  busy: actionSchema,
  offline: offlineActionSchema,
});

const matchRuleSchema = actionsSchema
  .extend({
    match: z
      .object({
        tier: tierSchema.optional(),
        label: z.string().min(1).optional(),
      })
      .strict()
      .refine((m) => m.tier !== undefined || m.label !== undefined, {
        message: "a match needs at least a tier or a label",
      }),
    notify: z.boolean().default(false),
  })
  .strict();

const defaultRuleSchema = z
  .object({
    default: actionsSchema.extend({ notify: z.boolean().default(false) }).strict(),
  })
  .strict();

const ruleSchema = z.union([matchRuleSchema, defaultRuleSchema]);

const secretSchema = z.string().min(16, "secrets and tokens must be at least 16 characters");

export const configSchema = z
  .object({
    server: z
      .object({
        port: z.number().int().min(1).max(65535).default(8790),
        /** Bind address. Loopback by default; use 0.0.0.0 inside a container. */
        host: z.string().min(1).default("127.0.0.1"),
        publicUrl: z.url(),
        /**
         * Upper bound for one forward to a runner, including reading its response
         * body. A runner that stalls is treated as failed after this long.
         */
        runnerTimeoutMs: z
          .number()
          .int()
          .min(1_000)
          .max(24 * 3600 * 1000)
          .default(10 * 60 * 1000),
        /** Largest request body the dispatcher will read, in bytes. */
        maxBodyBytes: z
          .number()
          .int()
          .min(1024)
          .max(16 * 1024 * 1024)
          .default(1024 * 1024),
      })
      .strict(),
    nodes: z
      .record(
        nodeIdSchema,
        z
          .object({
            runner: z.url(),
            token: secretSchema,
            prefer: z.boolean().default(false),
          })
          .strict(),
      )
      .refine((n) => Object.keys(n).length > 0, { message: "configure at least one node" }),
    cloud: z.object({ runner: z.url() }).strict(),
    paperclip: z
      .object({
        apiUrl: z.url(),
        apiKey: z.string().min(1),
        sharedSecret: secretSchema,
        /**
         * Also add a `waiting-for-local` label to deferred issues. Off by default:
         * Paperclip can only replace an issue's whole label set and offers no
         * conditional update, so a label written by someone else at the same moment
         * could be lost. The deferral comment (append-only) is always posted.
         */
        labelDeferred: z.boolean().default(false),
      })
      .strict(),
    agents: z.record(z.string().min(1), z.object({ tier: tierSchema }).strict()).default({}),
    policies: z.array(ruleSchema).min(1),
    presence: z
      .object({
        offlineAfterSeconds: z.number().int().min(10).default(90),
        drainConcurrency: z.number().int().min(1).max(32).default(2),
        deferredMaxAgeHours: z.number().int().min(1).default(72),
      })
      .strict()
      .default({ offlineAfterSeconds: 90, drainConcurrency: 2, deferredMaxAgeHours: 72 }),
    notify: z
      .object({
        telegram: z.object({ botToken: z.string().min(1), chatId: z.string().min(1) }).strict(),
        webhook: z.object({ url: z.url() }).strict(),
      })
      .partial()
      .strict()
      .optional(),
  })
  .strict();

export type EbbgateConfig = z.infer<typeof configSchema>;
export type PolicyRule = EbbgateConfig["policies"][number];
export type MatchRule = z.infer<typeof matchRuleSchema>;
export type DefaultRule = z.infer<typeof defaultRuleSchema>;

export function isDefaultRule(rule: PolicyRule): rule is DefaultRule {
  return "default" in rule;
}

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

export interface ConfigIssue {
  /** Dotted path into the config, e.g. `policies.2.offline`. */
  path: string;
  message: string;
}

export class ConfigError extends Error {
  readonly issues: ConfigIssue[];

  constructor(issues: ConfigIssue[]) {
    super(
      `Invalid Ebbgate config:\n${issues.map((i) => `  - ${i.path || "(root)"}: ${i.message}`).join("\n")}`,
    );
    this.name = "ConfigError";
    this.issues = issues;
  }
}

/* ------------------------------------------------------------------ */
/* Environment interpolation                                           */
/* ------------------------------------------------------------------ */

const ENV_REF = /\$\{([A-Z_][A-Z0-9_]*)\}/g;

/**
 * Replace `${VAR}` references inside string values with values from `env`.
 * Interpolation happens after YAML parsing, so env values can never change
 * the structure of the config. All missing variables are reported at once.
 */
export function interpolateEnv(
  value: unknown,
  env: Record<string, string | undefined>,
  path: string[] = [],
  missing: ConfigIssue[] = [],
): unknown {
  if (typeof value === "string") {
    return value.replace(ENV_REF, (_, name: string) => {
      const v = env[name];
      if (v === undefined || v === "") {
        missing.push({
          path: path.join("."),
          message: `environment variable ${name} is not set`,
        });
        return "";
      }
      return v;
    });
  }
  if (Array.isArray(value)) {
    return value.map((v, i) => interpolateEnv(v, env, [...path, String(i)], missing));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = interpolateEnv(v, env, [...path, k], missing);
    }
    return out;
  }
  return value;
}

/* ------------------------------------------------------------------ */
/* Privacy validation                                                  */
/* ------------------------------------------------------------------ */

/**
 * Reject any rule that could route a `private` task to the cloud.
 *
 * Rules are first-match. A rule can see private tasks unless an earlier rule
 * matches *every* private task (`match: { tier: private }` with no label).
 * Label-only rules, `tier: private` rules and the default rule can all see
 * private tasks until that point, so none of them may use `cloud`.
 */
export function validatePrivacy(policies: readonly PolicyRule[]): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  let privateCaptured = false;

  policies.forEach((rule, i) => {
    const actions = isDefaultRule(rule) ? rule.default : rule;
    const canSeePrivate =
      !privateCaptured &&
      (isDefaultRule(rule) || rule.match.tier === undefined || rule.match.tier === "private");

    if (canSeePrivate) {
      for (const state of ["available", "busy", "offline"] as const) {
        if (actions[state] === "cloud") {
          issues.push({
            path: `policies.${i}${isDefaultRule(rule) ? ".default" : ""}.${state}`,
            message:
              "this rule can match private tasks, which must never run in the cloud. " +
              "Use 'defer' or a local action, or add an earlier rule `match: { tier: private }`.",
          });
        }
      }
    }

    if (!isDefaultRule(rule) && rule.match.tier === "private" && rule.match.label === undefined) {
      privateCaptured = true;
    }
  });

  return issues;
}

/** Compare runner URLs the way fetch() would resolve them. */
function sameEndpoint(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return (
      ua.origin === ub.origin && ua.pathname.replace(/\/+$/, "") === ub.pathname.replace(/\/+$/, "")
    );
  } catch {
    return a === b;
  }
}

/**
 * A node whose runner is the cloud runner would send "local" (including private)
 * work to the cloud. Reject it: the local/cloud split must be real.
 */
export function validateRunnerSeparation(
  config: Pick<EbbgateConfig, "nodes" | "cloud">,
): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  for (const [id, n] of Object.entries(config.nodes)) {
    if (sameEndpoint(n.runner, config.cloud.runner)) {
      issues.push({
        path: `nodes.${id}.runner`,
        message:
          "this node's runner is the cloud runner, so private work sent to it would run in the cloud. " +
          "Point the node at its own runner on that machine.",
      });
    }
  }
  return issues;
}

function validateStructure(config: EbbgateConfig): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const defaults = config.policies.map((r, i) => ({ r, i })).filter(({ r }) => isDefaultRule(r));

  if (defaults.length === 0) {
    issues.push({ path: "policies", message: "add a final `default` rule" });
  } else if (defaults.length > 1) {
    issues.push({ path: "policies", message: "only one `default` rule is allowed" });
  } else if (defaults[0] && defaults[0].i !== config.policies.length - 1) {
    issues.push({
      path: `policies.${defaults[0].i}`,
      message: "the `default` rule must be the last rule (rules after it can never match)",
    });
  }
  return issues;
}

/* ------------------------------------------------------------------ */
/* Loading                                                             */
/* ------------------------------------------------------------------ */

/** Validate an already-parsed config object. Throws `ConfigError`. */
export function parseConfig(
  raw: unknown,
  env: Record<string, string | undefined> = {},
): EbbgateConfig {
  const missing: ConfigIssue[] = [];
  const interpolated = interpolateEnv(raw, env, [], missing);
  if (missing.length > 0) throw new ConfigError(missing);

  const result = configSchema.safeParse(interpolated);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((i) => ({
        path: i.path.map(String).join("."),
        message: i.message,
      })),
    );
  }

  const issues = [
    ...validateStructure(result.data),
    ...validatePrivacy(result.data.policies),
    ...validateRunnerSeparation(result.data),
  ];
  if (issues.length > 0) throw new ConfigError(issues);

  return result.data;
}

/**
 * Describe a YAML syntax error by code and position only. The parser's own
 * message quotes the offending source line, which may hold a secret, so it is
 * never passed through.
 */
function describeYamlError(err: unknown): string {
  const e = err as { code?: unknown; linePos?: Array<{ line?: number; col?: number }> };
  const code = typeof e?.code === "string" ? e.code : "SYNTAX_ERROR";
  const pos = Array.isArray(e?.linePos) ? e.linePos[0] : undefined;
  const where =
    pos && typeof pos.line === "number" && typeof pos.col === "number"
      ? ` at line ${pos.line}, column ${pos.col}`
      : "";
  return `YAML parse error (${code})${where}`;
}

/** Parse and validate a YAML config string. Throws `ConfigError`. */
export function loadConfig(
  yamlText: string,
  env: Record<string, string | undefined> = {},
): EbbgateConfig {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText, { prettyErrors: false });
  } catch (err) {
    throw new ConfigError([{ path: "", message: describeYamlError(err) }]);
  }
  return parseConfig(raw, env);
}
