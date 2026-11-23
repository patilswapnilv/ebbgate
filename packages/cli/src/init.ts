import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { resolve } from "node:path";
import * as p from "@clack/prompts";
import { DETECT_DEFAULTS, detectServices } from "./detect.js";
import { type InitAnswers, renderEbbgateYaml, type Tier } from "./generate/ebbgate-yaml.js";
import { renderEnvExample } from "./generate/env-example.js";
import { renderLitellmConfig } from "./generate/litellm.js";
import { envKeyForNodeToken, generateSecret } from "./generate/secrets.js";
import {
  maskSecret,
  readExistingSecrets,
  renderSecretsFile,
  SECRETS_FILE,
  writeSecretsFile,
} from "./generate/secrets-file.js";
import { listPaperclipAgents } from "./paperclip-agents.js";

export interface InitOptions {
  cwd?: string;
  /** Non-interactive: secure defaults, no prompts. For scripts, CI and tests. */
  yes?: boolean;
  /** Replace existing files. Secrets already in .env are kept. */
  force?: boolean;
  fetch?: typeof fetch;
  /** Process environment (PAPERCLIP_API_KEY is picked up from here). */
  env?: NodeJS.ProcessEnv;
  answers?: Partial<InitAnswers> & { companyId?: string; paperclipApiKey?: string };
}

export interface InitResult {
  files: string[];
  answers: InitAnswers;
  /** Absolute path of the 0600 secrets file. */
  secretsFile: string;
  sharedSecret: string;
  nodeSecrets: Record<string, string>;
  /** Human-readable summary with every secret masked. Safe to print. */
  summary: string;
}

const TIERS: Tier[] = ["private", "internal", "public"];
const NODE_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

export const INIT_FILES = [
  "ebbgate.yaml",
  SECRETS_FILE,
  ".env.example",
  "litellm.config.yaml",
] as const;

export class ExistingConfigError extends Error {
  constructor(readonly existing: string[]) {
    super(
      `refusing to overwrite existing ${existing.join(", ")}; ` +
        "re-run with --force to replace them (secrets in .env are kept), or run init in an empty directory",
    );
    this.name = "ExistingConfigError";
  }
}

/** A node id from this machine's hostname, e.g. "Swapnils-MacBook-Pro.local" → "swapnils-macbook-pro". */
export function defaultNodeId(host: string = hostname()): string {
  const id = host
    .split(".")[0]
    ?.toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/, "");
  return id && NODE_ID.test(id) ? id : "mini";
}

function isLoopbackUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h === "localhost" || h === "[::1]" || h.startsWith("127.");
  } catch {
    return false;
  }
}

export async function runInit(opts: InitOptions = {}): Promise<InitResult> {
  const cwd = resolve(opts.cwd ?? process.cwd());
  const fetchFn = opts.fetch ?? fetch;
  const env = opts.env ?? process.env;
  const secretsPath = resolve(cwd, SECRETS_FILE);

  // Check before asking anything: never lose node definitions, tiers or model settings.
  const existing = INIT_FILES.filter((f) => existsSync(resolve(cwd, f)));
  if (existing.length > 0 && !opts.force) {
    if (opts.yes) throw new ExistingConfigError(existing);
    p.intro("ebbgate init");
    const ok = await p.confirm({
      message: `${existing.join(", ")} already exist in ${cwd}. Replace them? (secrets in .env are kept)`,
      initialValue: false,
    });
    if (p.isCancel(ok) || !ok) return cancel();
  } else if (!opts.yes) {
    p.intro("ebbgate init");
  }

  const detected = await detectServices(fetchFn);

  let ollamaUrl = opts.answers?.ollamaUrl ?? detected.ollama ?? DETECT_DEFAULTS.ollama;
  const litellmUrl = opts.answers?.litellmUrl ?? detected.litellm ?? DETECT_DEFAULTS.litellm;
  let paperclipApiUrl =
    opts.answers?.paperclipApiUrl ?? detected.paperclip ?? DETECT_DEFAULTS.paperclip;

  if (!opts.yes) {
    for (const [name, found] of [
      ["Ollama", detected.ollama],
      ["Paperclip", detected.paperclip],
    ] as const) {
      if (found) p.log.success(`${name} detected at ${found}`);
    }
    if (!detected.ollama && !opts.answers?.ollamaUrl) {
      ollamaUrl = await askText("Ollama URL (not detected on :11434)", DETECT_DEFAULTS.ollama);
    }
    if (!detected.paperclip && !opts.answers?.paperclipApiUrl) {
      paperclipApiUrl = await askText(
        "Paperclip API URL (not detected on :3100)",
        DETECT_DEFAULTS.paperclip,
      );
    }
  }

  let nodeIds = opts.answers?.nodes?.map((n) => n.id) ?? [defaultNodeId()];
  if (!opts.yes && !opts.answers?.nodes) {
    const nodesRaw = await p.text({
      message: "Node id for this Mac (comma-separate to add more machines)",
      initialValue: nodeIds.join(","),
      validate: (v) => {
        const parts = splitCsv(v ?? "");
        if (parts.length === 0) return "add at least one node";
        for (const id of parts) {
          if (!NODE_ID.test(id))
            return `invalid node id: ${id} (lowercase letters, digits, dashes)`;
        }
      },
    });
    if (p.isCancel(nodesRaw)) return cancel();
    nodeIds = splitCsv(nodesRaw);
  }

  const publicUrl =
    opts.answers?.publicUrl ??
    (opts.yes
      ? "http://127.0.0.1:8790"
      : await askText(
          "Dispatcher URL (Paperclip calls <url>/run; keep 127.0.0.1 if it runs on this Mac)",
          "http://127.0.0.1:8790",
        ));

  // Secure default: no cloud runner, so nothing leaves your machines.
  let cloudRunner = opts.answers?.cloudRunner;
  if (!opts.yes && cloudRunner === undefined) {
    const v = await p.text({
      message: "Cloud runner URL (optional; leave blank to keep all work local)",
      placeholder: "blank = no cloud: non-private work waits for your Mac too",
      validate: (raw) => {
        const s = (raw ?? "").trim();
        if (!s) return;
        try {
          new URL(s);
        } catch {
          return "enter a full URL, or leave blank";
        }
      },
    });
    if (p.isCancel(v)) return cancel();
    cloudRunner = v.trim() || undefined;
  }

  const existingSecrets = readExistingSecrets(secretsPath);
  let paperclipApiKey =
    opts.answers?.paperclipApiKey ?? env.PAPERCLIP_API_KEY ?? existingSecrets.PAPERCLIP_API_KEY;
  const agents: Array<{ id: string; tier: Tier }> = opts.answers?.agents
    ? [...opts.answers.agents]
    : [];

  if (!opts.yes) {
    if (!paperclipApiKey) {
      const key = await p.password({
        message: "Paperclip API key (optional; stored only in .env, mode 600)",
      });
      if (p.isCancel(key)) return cancel();
      paperclipApiKey = key.trim() || undefined;
    }

    if (!opts.answers?.agents) {
      const companyId =
        opts.answers?.companyId ??
        (await askText("Paperclip company id (optional, to list your agents)", ""));
      if (companyId.trim() && paperclipApiKey) {
        const listed = await listPaperclipAgents(
          paperclipApiUrl,
          paperclipApiKey,
          companyId.trim(),
          fetchFn,
        );
        if (listed.length > 0) {
          p.log.info(`Found ${listed.length} agent(s). Anything you skip stays private.`);
          for (const ag of listed) {
            const tier = await p.select({
              message: `Tier for ${ag.name ?? ag.id}`,
              initialValue: "private" as Tier,
              options: TIERS.map((t) => ({ value: t, label: t })),
            });
            if (p.isCancel(tier)) return cancel();
            agents.push({ id: ag.id, tier: tier as Tier });
          }
        } else {
          p.log.warn("No agents returned. You can list them by hand below.");
        }
      }

      if (agents.length === 0) {
        const manual = await p.text({
          message: "Non-private agents as id:tier (optional; unlisted agents stay private)",
          placeholder: "e.g. agent_research:public,agent_ops:internal",
          validate: (v) => {
            if (!(v ?? "").trim()) return;
            try {
              parseAgents(v ?? "");
            } catch (e) {
              return (e as Error).message;
            }
          },
        });
        if (p.isCancel(manual)) return cancel();
        if (manual.trim()) agents.push(...parseAgents(manual));
      }
    }
  }

  const loopback = isLoopbackUrl(publicUrl);
  const answers: InitAnswers = {
    publicUrl,
    dispatcherPort: opts.answers?.dispatcherPort ?? 8790,
    nodes: (
      opts.answers?.nodes ??
      nodeIds.map((id, i): InitAnswers["nodes"][number] => ({ id, prefer: i === 0 }))
    ).map((n, i) =>
      // One-machine setup: the dispatcher reaches this Mac's runner on loopback.
      i === 0 && loopback && !n.runner ? { ...n, runner: "http://127.0.0.1:8787" } : n,
    ),
    ...(cloudRunner ? { cloudRunner } : {}),
    paperclipApiUrl,
    ollamaUrl,
    litellmUrl,
    agents,
    includeNotifyPlaceholders: opts.answers?.includeNotifyPlaceholders ?? true,
  };

  // Keep secrets that already exist, so nodes and Paperclip keep working after --force.
  const sharedSecret = existingSecrets.EG_PAPERCLIP_SECRET || generateSecret();
  const nodeSecrets: Record<string, string> = {};
  for (const n of answers.nodes) {
    const key = envKeyForNodeToken(n.id);
    nodeSecrets[key] = existingSecrets[key] || generateSecret();
  }

  mkdirSync(cwd, { recursive: true });
  writeSecretsFile(
    secretsPath,
    renderSecretsFile({
      sharedSecret,
      nodeTokens: nodeSecrets,
      ...(paperclipApiKey ? { paperclipApiKey } : {}),
    }),
  );
  const files = [
    write(cwd, "ebbgate.yaml", renderEbbgateYaml(answers)),
    secretsPath,
    write(cwd, ".env.example", renderEnvExample(answers.nodes)),
    write(cwd, "litellm.config.yaml", renderLitellmConfig(answers.ollamaUrl)),
  ];
  const gitignored = ensureGitignored(cwd, SECRETS_FILE);

  const summary = renderSummary({
    answers,
    secretsPath,
    sharedSecret,
    nodeSecrets,
    hasPaperclipKey: Boolean(paperclipApiKey),
    gitignored,
  });

  if (!opts.yes) {
    p.note(summary, "Configured");
    p.outro("Next: ebbgate doctor");
  }

  return { files, answers, secretsFile: secretsPath, sharedSecret, nodeSecrets, summary };
}

function renderSummary(a: {
  answers: InitAnswers;
  secretsPath: string;
  sharedSecret: string;
  nodeSecrets: Record<string, string>;
  hasPaperclipKey: boolean;
  gitignored: boolean;
}): string {
  const firstNode = a.answers.nodes[0]?.id ?? "mini";
  const lines = [
    `Secrets written to ${a.secretsPath} (mode 600, never printed in full):`,
    `  EG_PAPERCLIP_SECRET=${maskSecret(a.sharedSecret)}`,
    ...Object.entries(a.nodeSecrets).map(([k, v]) => `  ${k}=${maskSecret(v)}`),
    `  PAPERCLIP_API_KEY=${a.hasPaperclipKey ? "(set)" : "(not set: add it to .env)"}`,
    ...(a.gitignored ? ["  (.env added to .gitignore)"] : []),
    "",
    a.answers.cloudRunner
      ? `Cloud runner: ${a.answers.cloudRunner} (non-private work may run there)`
      : "Cloud runner: none. Nothing leaves your machines; work waits for a local node.",
    "Unknown agents: treated as private.",
    "",
    "Paperclip http adapter:",
    `  url: ${a.answers.publicUrl.replace(/\/$/, "")}/run`,
    "  headers.Authorization: Bearer <EG_PAPERCLIP_SECRET from .env>",
    "",
    "Next steps:",
    "  1. ebbgate doctor                       check everything, with a fix for each problem",
    "  2. start the dispatcher                 see README → Quickstart",
    `  3. ebbgate agent install --node ${firstNode}   presence agent on this Mac (launchd)`,
    "  4. ebbgate doctor                       all green",
  ];
  return lines.join("\n");
}

/** Add `entry` to an existing .gitignore. Never creates one. Returns true if it added it. */
function ensureGitignored(cwd: string, entry: string): boolean {
  const path = resolve(cwd, ".gitignore");
  if (!existsSync(path)) return false;
  const text = readFileSync(path, "utf8");
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  if (lines.includes(entry) || lines.includes(`/${entry}`)) return false;
  appendFileSync(path, `${text.endsWith("\n") || text === "" ? "" : "\n"}${entry}\n`);
  return true;
}

function write(cwd: string, name: string, body: string): string {
  const path = resolve(cwd, name);
  writeFileSync(path, body.endsWith("\n") ? body : `${body}\n`, "utf8");
  return path;
}

function splitCsv(v: string): string[] {
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseAgents(raw: string): Array<{ id: string; tier: Tier }> {
  const out: Array<{ id: string; tier: Tier }> = [];
  for (const part of splitCsv(raw)) {
    const [id, tier] = part.split(":").map((s) => s.trim());
    if (!id || !tier) throw new Error(`expected id:tier, got ${part}`);
    if (!TIERS.includes(tier as Tier)) throw new Error(`bad tier for ${id}: ${tier}`);
    out.push({ id, tier: tier as Tier });
  }
  return out;
}

async function askText(message: string, initialValue: string): Promise<string> {
  const v = await p.text({ message, initialValue });
  if (p.isCancel(v)) return cancel();
  return v ?? "";
}

function cancel(): never {
  p.cancel("Init cancelled.");
  process.exit(0);
}
