import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import * as p from "@clack/prompts";
import { DETECT_DEFAULTS, detectServices } from "./detect.js";
import { type InitAnswers, renderEbbgateYaml, type Tier } from "./generate/ebbgate-yaml.js";
import { renderEnvExample } from "./generate/env-example.js";
import { renderLitellmConfig } from "./generate/litellm.js";
import { envKeyForNodeToken, generateSecret } from "./generate/secrets.js";
import { listPaperclipAgents } from "./paperclip-agents.js";

export interface InitOptions {
  cwd?: string;
  /** Non-interactive defaults for tests / CI. */
  yes?: boolean;
  /** Replace existing ebbgate.yaml / .env.example / litellm.config.yaml. */
  force?: boolean;
  fetch?: typeof fetch;
  answers?: Partial<InitAnswers> & { companyId?: string; paperclipApiKey?: string };
}

export interface InitResult {
  files: string[];
  answers: InitAnswers;
  sharedSecret: string;
  nodeSecrets: Record<string, string>;
}

const TIERS: Tier[] = ["private", "internal", "public"];

export const INIT_FILES = ["ebbgate.yaml", ".env.example", "litellm.config.yaml"] as const;

export class ExistingConfigError extends Error {
  constructor(readonly existing: string[]) {
    super(
      `refusing to overwrite existing ${existing.join(", ")}; ` +
        "re-run with --force to replace them (or run init in an empty directory)",
    );
    this.name = "ExistingConfigError";
  }
}

export async function runInit(opts: InitOptions = {}): Promise<InitResult> {
  const cwd = resolve(opts.cwd ?? process.cwd());
  const fetchFn = opts.fetch ?? fetch;

  // Check before asking anything: never lose node definitions, tiers or model settings.
  const existing = INIT_FILES.filter((f) => existsSync(resolve(cwd, f)));
  if (existing.length > 0 && !opts.force) {
    if (opts.yes) throw new ExistingConfigError(existing);
    p.intro("ebbgate init");
    const ok = await p.confirm({
      message: `${existing.join(", ")} already exist in ${cwd}. Replace them?`,
      initialValue: false,
    });
    if (p.isCancel(ok) || !ok) return cancel();
  } else if (!opts.yes) {
    p.intro("ebbgate init");
  }

  const detected = await detectServices(fetchFn);

  let ollamaUrl = opts.answers?.ollamaUrl ?? detected.ollama ?? DETECT_DEFAULTS.ollama;
  let litellmUrl = opts.answers?.litellmUrl ?? detected.litellm ?? DETECT_DEFAULTS.litellm;
  let paperclipApiUrl =
    opts.answers?.paperclipApiUrl ?? detected.paperclip ?? DETECT_DEFAULTS.paperclip;

  if (!opts.yes) {
    if (!detected.ollama) {
      const v = await p.text({
        message: "Ollama URL (not detected on :11434)",
        initialValue: DETECT_DEFAULTS.ollama,
      });
      if (p.isCancel(v)) return cancel();
      ollamaUrl = v;
    } else {
      p.log.success(`Ollama detected at ${detected.ollama}`);
    }

    if (!detected.litellm) {
      const v = await p.text({
        message: "LiteLLM URL (not detected on :4000)",
        initialValue: DETECT_DEFAULTS.litellm,
      });
      if (p.isCancel(v)) return cancel();
      litellmUrl = v;
    } else {
      p.log.success(`LiteLLM detected at ${detected.litellm}`);
    }

    if (!detected.paperclip) {
      const v = await p.text({
        message: "Paperclip API URL (not detected on :3100)",
        initialValue: DETECT_DEFAULTS.paperclip,
      });
      if (p.isCancel(v)) return cancel();
      paperclipApiUrl = v;
    } else {
      p.log.success(`Paperclip detected at ${detected.paperclip}`);
    }
  }

  let nodeIds = opts.answers?.nodes?.map((n) => n.id) ?? ["mini"];
  if (!opts.yes) {
    const nodesRaw = await p.text({
      message: "Node ids (comma-separated, lowercase)",
      initialValue: "mini",
      validate: (v) => {
        const parts = splitCsv(v);
        if (parts.length === 0) return "add at least one node";
        for (const id of parts) {
          if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(id)) return `invalid node id: ${id}`;
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
      : await askText("Dispatcher publicUrl (Paperclip calls this /run)", "http://127.0.0.1:8790"));

  const cloudRunner =
    opts.answers?.cloudRunner ??
    (opts.yes
      ? "http://openclaw:18789/paperclip"
      : await askText("Cloud runner URL", "http://127.0.0.1:18789/paperclip"));

  const agents: Array<{ id: string; tier: Tier }> = opts.answers?.agents
    ? [...opts.answers.agents]
    : [];

  if (!opts.yes) {
    const companyId = await p.text({
      message: "Paperclip company id (optional, to list agents)",
      placeholder: "leave blank to enter agents manually",
    });
    if (p.isCancel(companyId)) return cancel();

    const apiKey = await p.text({
      message: "Paperclip API key (optional, used only to list agents)",
      placeholder: "leave blank to skip",
    });
    if (p.isCancel(apiKey)) return cancel();

    if (companyId.trim() && apiKey.trim()) {
      const listed = await listPaperclipAgents(
        paperclipApiUrl,
        apiKey.trim(),
        companyId.trim(),
        fetchFn,
      );
      if (listed.length > 0) {
        p.log.info(`Found ${listed.length} agent(s)`);
        for (const ag of listed) {
          const tier = await p.select({
            message: `Tier for ${ag.name ?? ag.id}`,
            options: TIERS.map((t) => ({ value: t, label: t })),
          });
          if (p.isCancel(tier)) return cancel();
          agents.push({ id: ag.id, tier: tier as Tier });
        }
      } else {
        p.log.warn("No agents returned (or API shape differed). Enter manually.");
      }
    }

    if (agents.length === 0) {
      const manual = await p.text({
        message: "Agents as id:tier pairs (comma-separated)",
        initialValue: "agent_inbox:private,agent_ops:internal,agent_research:public",
        validate: (v) => {
          try {
            parseAgents(v);
          } catch (e) {
            return (e as Error).message;
          }
        },
      });
      if (p.isCancel(manual)) return cancel();
      agents.push(...parseAgents(manual));
    }
  } else if (agents.length === 0) {
    agents.push(
      { id: "agent_inbox", tier: "private" },
      { id: "agent_ops", tier: "internal" },
      { id: "agent_research", tier: "public" },
    );
  }

  const answers: InitAnswers = {
    publicUrl,
    dispatcherPort: opts.answers?.dispatcherPort ?? 8790,
    nodes: nodeIds.map((id, i) => ({ id, prefer: i === 0 })),
    cloudRunner,
    paperclipApiUrl,
    ollamaUrl,
    litellmUrl,
    agents,
    includeNotifyPlaceholders: opts.answers?.includeNotifyPlaceholders ?? true,
  };

  const sharedSecret = generateSecret();
  const nodeSecrets: Record<string, string> = {};
  for (const n of answers.nodes) {
    nodeSecrets[envKeyForNodeToken(n.id)] = generateSecret();
  }

  mkdirSync(cwd, { recursive: true });
  const files = [
    write(cwd, "ebbgate.yaml", renderEbbgateYaml(answers)),
    write(cwd, ".env.example", renderEnvExample(answers.nodes)),
    write(cwd, "litellm.config.yaml", renderLitellmConfig(answers.ollamaUrl)),
  ];

  // Also write a local .env with generated secrets if missing? Spec says .env.example only.
  // Print secrets for the user to copy.

  const nextSteps = `
Paperclip agent adapter settings (http):
  adapterType: http
  url: ${answers.publicUrl.replace(/\/$/, "")}/run
  headers.Authorization: Bearer <EG_PAPERCLIP_SECRET>
  (use the same value as EG_PAPERCLIP_SECRET in .env)

Suggested EG_PAPERCLIP_SECRET:
  ${sharedSecret}

Node tokens (put in .env):
${Object.entries(nodeSecrets)
  .map(([k, v]) => `  ${k}=${v}`)
  .join("\n")}

Next steps:
  1. Copy .env.example → .env and fill PAPERCLIP_API_KEY + the secrets above
  2. Start the dispatcher:  node packages/dispatcher/dist/index.js
     (or: docker compose -f examples/compose/docker-compose.yml up)
  3. On each Mac node, put only that node's token in ~/.ebbgate/.env (chmod 600), then:
     pnpm ebbgate agent install --node <id> --dispatcher ${answers.publicUrl} --config ./ebbgate.yaml --env-file ~/.ebbgate/.env --runner-host <reachable IP>
  4. On each Mac node:  pnpm ebbgate runner   # local shim on :8787
`;

  if (!opts.yes) {
    p.note(nextSteps.trim(), "Configured");
    p.outro("Done. Keep secrets out of git.");
  }

  return { files, answers, sharedSecret, nodeSecrets };
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
  if (out.length === 0) throw new Error("add at least one agent");
  return out;
}

async function askText(message: string, initialValue: string): Promise<string> {
  const v = await p.text({ message, initialValue });
  if (p.isCancel(v)) {
    p.cancel("Init cancelled.");
    process.exit(0);
  }
  return v;
}

function cancel(): never {
  p.cancel("Init cancelled.");
  process.exit(0);
}
