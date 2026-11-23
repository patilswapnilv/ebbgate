import { spawn } from "node:child_process";

/**
 * Getting a newcomer a working local model: detect Ollama, offer to install and
 * start it, and offer to pull a small default model. Nothing here runs an
 * installer, starts a service or downloads a model without consent, and every
 * process call goes through a `ProcessRunner` so it can be unit-tested.
 */

/** Small (3B, about 2 GB), widely available, and what the LiteLLM `private-fast` alias expects. */
export const DEFAULT_OLLAMA_MODEL = "llama3.2";
export const OLLAMA_DOWNLOAD_URL = "https://ollama.com/download";
export const OLLAMA_INSTALL_SCRIPT = "curl -fsSL https://ollama.com/install.sh | sh";
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;

export function isValidModelName(name: string): boolean {
  return MODEL_NAME.test(name);
}

/** Process execution, abstracted so tests never run real installers. */
export interface ProcessRunner {
  /** True if `cmd` is on PATH. */
  which(cmd: string): Promise<boolean>;
  /** Run to completion with the terminal attached (no shell). Resolves the exit code. */
  run(cmd: string, args: string[], env?: Record<string, string>): Promise<number>;
  /** Start a long-running process in the background, detached from init. */
  spawnDetached(cmd: string, args: string[], env?: Record<string, string>): void;
}

export const systemRunner: ProcessRunner = {
  which: (cmd) =>
    new Promise((resolve) => {
      const probe =
        process.platform === "win32"
          ? spawn("where", [cmd], { stdio: "ignore" })
          : spawn("sh", ["-c", 'command -v "$1" >/dev/null 2>&1', "sh", cmd], {
              stdio: "ignore",
            });
      probe.on("error", () => resolve(false));
      probe.on("close", (code) => resolve(code === 0));
    }),
  run: (cmd, args, env) =>
    new Promise((resolve) => {
      const child = spawn(cmd, args, { stdio: "inherit", env: { ...process.env, ...env } });
      child.on("error", () => resolve(127));
      child.on("close", (code) => resolve(code ?? 1));
    }),
  spawnDetached: (cmd, args, env) => {
    const child = spawn(cmd, args, {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, ...env },
    });
    child.on("error", () => {});
    child.unref();
  },
};

export type InstallPlan =
  | { kind: "brew"; display: string; steps: Array<[string, string[]]> }
  | { kind: "script"; display: string; steps: Array<[string, string[]]> }
  | { kind: "manual"; url: string; reason: string };

/** How Ollama would be installed on this machine. Pure apart from `which`. */
export async function planOllamaInstall(
  platform: NodeJS.Platform,
  runner: ProcessRunner,
): Promise<InstallPlan> {
  if (platform === "darwin") {
    if (await runner.which("brew")) {
      return {
        kind: "brew",
        display: "brew install ollama && brew services start ollama",
        steps: [
          ["brew", ["install", "ollama"]],
          ["brew", ["services", "start", "ollama"]],
        ],
      };
    }
    return {
      kind: "manual",
      url: OLLAMA_DOWNLOAD_URL,
      reason: "Homebrew not found: download the Ollama app, open it once, then re-run init",
    };
  }
  if (platform === "linux") {
    if (await runner.which("curl")) {
      return {
        kind: "script",
        display: OLLAMA_INSTALL_SCRIPT,
        steps: [["sh", ["-c", OLLAMA_INSTALL_SCRIPT]]],
      };
    }
    return {
      kind: "manual",
      url: OLLAMA_DOWNLOAD_URL,
      reason: "curl not found: follow the Linux instructions",
    };
  }
  return {
    kind: "manual",
    url: OLLAMA_DOWNLOAD_URL,
    reason: "install Ollama for your platform",
  };
}

/** One-line install hint, shared with `ebbgate doctor`. */
export function ollamaInstallHint(platform: NodeJS.Platform): string {
  if (platform === "darwin") {
    return `install Ollama: \`brew install ollama && brew services start ollama\` (or download it from ${OLLAMA_DOWNLOAD_URL})`;
  }
  if (platform === "linux") {
    return `install Ollama with the official script: \`${OLLAMA_INSTALL_SCRIPT}\` (see ${OLLAMA_DOWNLOAD_URL})`;
  }
  return `install Ollama from ${OLLAMA_DOWNLOAD_URL}`;
}

export function ollamaStartHint(platform: NodeJS.Platform): string {
  return platform === "darwin"
    ? "start Ollama: open the Ollama app, or `brew services start ollama`, or `ollama serve`"
    : "start Ollama: `ollama serve` (or `systemctl start ollama` if installed as a service)";
}

export function ollamaPullHint(model: string): string {
  return `pull a model: \`ollama pull ${model}\``;
}

/** "llama3.2" matches "llama3.2:latest"; a tagged name must match exactly. */
export function hasModel(installed: readonly string[], model: string): boolean {
  const want = model.includes(":") ? model : `${model}:latest`;
  return installed.some((m) => m === model || m === want);
}

export interface OllamaProbe {
  reachable: boolean;
  models: string[];
  error?: string;
}

export async function probeOllamaTags(
  baseUrl: string,
  fetchFn: typeof fetch,
  timeoutMs = 1_500,
): Promise<OllamaProbe> {
  try {
    const res = await fetchFn(`${baseUrl.replace(/\/$/, "")}/api/tags`, {
      method: "GET",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { reachable: false, models: [], error: `HTTP ${res.status}` };
    const body = (await res.json().catch(() => ({}))) as { models?: Array<{ name?: unknown }> };
    const models = Array.isArray(body.models)
      ? body.models.map((m) => m?.name).filter((n): n is string => typeof n === "string" && !!n)
      : [];
    return { reachable: true, models };
  } catch (err) {
    return {
      reachable: false,
      models: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function isLoopback(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h === "localhost" || h === "[::1]" || h.startsWith("127.");
  } catch {
    return false;
  }
}

/** `ask` prompts (interactive), `accept` is --yes, `skip` is --no-ollama or non-interactive. */
export type OllamaSetupMode = "ask" | "accept" | "skip";

export interface OllamaSetupOptions {
  ollamaUrl: string;
  model: string;
  mode: OllamaSetupMode;
  /** Why setup was skipped, when mode is "skip" (shown to the user). */
  skipReason?: string;
  runner: ProcessRunner;
  platform: NodeJS.Platform;
  fetch: typeof fetch;
  /** Ask a yes/no question. Only called in "ask" mode. */
  confirm: (message: string) => Promise<boolean>;
  log: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  /** How long to wait for Ollama to answer after installing or starting it. */
  waitMs?: number;
}

export type OllamaSetupOutcome =
  | "ready" // reachable and the model is present
  | "skipped"
  | "declined"
  | "manual" // user has to install it by hand (link printed)
  | "failed";

export interface OllamaSetupResult {
  outcome: OllamaSetupOutcome;
  /** What ran, for the summary and for tests. */
  ran: string[];
  /** Hints still to act on. */
  hints: string[];
}

/** Interactive Ollama + default model setup. Never throws for an install problem. */
export async function setupOllama(o: OllamaSetupOptions): Promise<OllamaSetupResult> {
  const ran: string[] = [];
  const hints: string[] = [];
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const waitMs = o.waitMs ?? 20_000;
  const url = o.ollamaUrl.replace(/\/$/, "");

  const consent = async (message: string, opts: { interactiveOnly?: boolean } = {}) => {
    if (o.mode === "ask") return o.confirm(message);
    if (o.mode === "accept" && !opts.interactiveOnly) return true;
    return false;
  };
  // The ollama CLI talks to OLLAMA_HOST; point it at the configured URL.
  const ollamaEnv = { OLLAMA_HOST: url };
  const exec = async (
    steps: Array<[string, string[]]>,
    env?: Record<string, string>,
  ): Promise<boolean> => {
    for (const [cmd, args] of steps) {
      const line = [cmd, ...args].join(" ");
      o.log(`$ ${line}`);
      ran.push(line);
      const code = await o.runner.run(cmd, args, env);
      if (code !== 0) {
        o.log(`\`${line}\` exited with ${code}`);
        return false;
      }
    }
    return true;
  };
  const waitUntilUp = async (): Promise<OllamaProbe> => {
    const step = 1_000;
    let probe = await probeOllamaTags(url, o.fetch);
    for (let waited = 0; !probe.reachable && waited < waitMs; waited += step) {
      await sleep(step);
      probe = await probeOllamaTags(url, o.fetch);
    }
    return probe;
  };

  let probe = await probeOllamaTags(url, o.fetch);

  if (!probe.reachable) {
    if (o.mode === "skip") {
      o.log(
        `Ollama is not reachable at ${url}. ${o.skipReason ?? "Skipping Ollama setup."} ` +
          "`ebbgate doctor` shows how to install it.",
      );
      hints.push(ollamaInstallHint(o.platform));
      return { outcome: "skipped", ran, hints };
    }
    if (!isLoopback(url)) {
      o.log(
        `Ollama is not reachable at ${url}. It's on another machine, so init won't install it.`,
      );
      hints.push(`start Ollama on the machine serving ${url}, or set the Ollama URL to this Mac`);
      return { outcome: "manual", ran, hints };
    }

    const installed = await o.runner.which("ollama");
    if (installed) {
      o.log(`Ollama is installed but not running at ${url}.`);
      if (!(await consent("Start Ollama now (`ollama serve` in the background)?"))) {
        hints.push(ollamaStartHint(o.platform));
        return { outcome: "declined", ran, hints };
      }
      o.log("$ ollama serve (background)");
      ran.push("ollama serve (background)");
      o.runner.spawnDetached("ollama", ["serve"], ollamaEnv);
    } else {
      o.log(
        `Ollama isn't installed. Ebbgate runs your private work on a local model, so you need it.`,
      );
      const plan = await planOllamaInstall(o.platform, o.runner);
      if (plan.kind === "manual") {
        o.log(`${plan.reason}: ${plan.url}`);
        hints.push(`install Ollama from ${plan.url}, then run \`ollama pull ${o.model}\``);
        return { outcome: "manual", ran, hints };
      }
      // Piping a remote script into a shell (it uses sudo) needs a human "yes", not --yes.
      const question =
        plan.kind === "script"
          ? `Install Ollama with the official script? This runs \`${plan.display}\` (it may ask for sudo).`
          : `Install Ollama now? This runs \`${plan.display}\`.`;
      if (!(await consent(question, { interactiveOnly: plan.kind === "script" }))) {
        if (plan.kind === "script" && o.mode === "accept") {
          o.log(
            "--yes does not run a remote install script; run init interactively, or install it yourself.",
          );
        }
        hints.push(ollamaInstallHint(o.platform));
        return { outcome: "declined", ran, hints };
      }
      if (!(await exec(plan.steps))) {
        hints.push(ollamaInstallHint(o.platform));
        return { outcome: "failed", ran, hints };
      }
    }

    probe = await waitUntilUp();
    if (!probe.reachable) {
      o.log(`Ollama still isn't answering at ${url}.`);
      hints.push(ollamaStartHint(o.platform));
      return { outcome: "failed", ran, hints };
    }
    o.log(`Ollama is up at ${url}.`);
  }

  if (hasModel(probe.models, o.model)) {
    o.log(`Model ${o.model} is already pulled.`);
    return { outcome: "ready", ran, hints };
  }
  if (o.mode === "skip") {
    hints.push(ollamaPullHint(o.model));
    return { outcome: "skipped", ran, hints };
  }
  if (!(await o.runner.which("ollama"))) {
    o.log(`Ollama answers at ${url}, but the \`ollama\` command isn't on PATH here.`);
    hints.push(ollamaPullHint(o.model));
    return { outcome: "manual", ran, hints };
  }
  if (!(await consent(`Pull the default model ${o.model} now? (a few GB, one-time download)`))) {
    hints.push(ollamaPullHint(o.model));
    return { outcome: "declined", ran, hints };
  }
  if (!(await exec([["ollama", ["pull", o.model]]], ollamaEnv))) {
    hints.push(ollamaPullHint(o.model));
    return { outcome: "failed", ran, hints };
  }
  return { outcome: "ready", ran, hints };
}
