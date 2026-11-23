import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnvFile } from "@ebbgate/agent";
import { loadConfig } from "@ebbgate/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ollamaMode } from "../src/cli.js";
import { runDoctor } from "../src/doctor.js";
import { runInit } from "../src/init.js";
import {
  DEFAULT_OLLAMA_MODEL,
  hasModel,
  OLLAMA_DOWNLOAD_URL,
  type OllamaSetupOptions,
  ollamaInstallHint,
  type ProcessRunner,
  planOllamaInstall,
  setupOllama,
} from "../src/ollama-setup.js";

/** A fake machine: which commands exist, what each run returns, and whether Ollama is up. */
function fakeMachine(opts: {
  onPath?: string[];
  up?: boolean;
  models?: string[];
  exit?: Record<string, number>;
  /** Commands that bring Ollama up when they succeed. */
  starts?: string[];
}) {
  const onPath = new Set(opts.onPath ?? []);
  const state = { up: opts.up ?? false, models: [...(opts.models ?? [])] };
  const runs: Array<{ line: string; env?: Record<string, string> }> = [];
  const detached: Array<{ line: string; env?: Record<string, string> }> = [];
  const starts = new Set(opts.starts ?? ["brew services start ollama", "sh -c"]);
  const runner: ProcessRunner = {
    which: async (cmd) => onPath.has(cmd),
    run: async (cmd, args, env) => {
      const line = [cmd, ...args].join(" ");
      runs.push({ line, ...(env ? { env } : {}) });
      const code = opts.exit?.[line] ?? 0;
      if (code === 0) {
        if ([...starts].some((s) => line.startsWith(s))) {
          state.up = true;
          onPath.add("ollama");
        }
        if (cmd === "ollama" && args[0] === "pull" && args[1]) state.models.push(args[1]);
      }
      return code;
    },
    spawnDetached: (cmd, args, env) => {
      detached.push({ line: [cmd, ...args].join(" "), ...(env ? { env } : {}) });
      state.up = true;
    },
  };
  const fetchFn = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (!state.up || url.pathname !== "/api/tags") throw new TypeError("fetch failed");
    return Response.json({ models: state.models.map((name) => ({ name })) });
  }) as typeof fetch;
  return { runner, fetchFn, runs, detached, state };
}

function options(
  m: ReturnType<typeof fakeMachine>,
  extra: Partial<OllamaSetupOptions> = {},
): OllamaSetupOptions & { asked: string[]; logs: string[] } {
  const asked: string[] = [];
  const logs: string[] = [];
  return {
    ollamaUrl: "http://127.0.0.1:11434",
    model: DEFAULT_OLLAMA_MODEL,
    mode: "accept",
    runner: m.runner,
    platform: "darwin",
    fetch: m.fetchFn,
    confirm: async (q) => {
      asked.push(q);
      return true;
    },
    log: (l) => logs.push(l),
    sleep: async () => {},
    waitMs: 3_000,
    asked,
    logs,
    ...extra,
  };
}

describe("planOllamaInstall", () => {
  it("uses Homebrew on macOS when it is there", async () => {
    const plan = await planOllamaInstall("darwin", fakeMachine({ onPath: ["brew"] }).runner);
    expect(plan.kind).toBe("brew");
    if (plan.kind !== "manual") {
      expect(plan.steps).toEqual([
        ["brew", ["install", "ollama"]],
        ["brew", ["services", "start", "ollama"]],
      ]);
    }
  });

  it("points to the download page on macOS without Homebrew", async () => {
    const plan = await planOllamaInstall("darwin", fakeMachine({}).runner);
    expect(plan).toMatchObject({ kind: "manual", url: OLLAMA_DOWNLOAD_URL });
  });

  it("offers the official script on Linux (with curl), the link otherwise", async () => {
    const plan = await planOllamaInstall("linux", fakeMachine({ onPath: ["curl"] }).runner);
    expect(plan.kind).toBe("script");
    if (plan.kind === "script") expect(plan.display).toContain("https://ollama.com/install.sh");
    expect((await planOllamaInstall("linux", fakeMachine({}).runner)).kind).toBe("manual");
    expect((await planOllamaInstall("win32", fakeMachine({}).runner)).kind).toBe("manual");
  });
});

describe("hasModel", () => {
  it("matches an untagged name to :latest, and tags exactly", () => {
    expect(hasModel(["llama3.2:latest"], "llama3.2")).toBe(true);
    expect(hasModel(["llama3.2:1b"], "llama3.2")).toBe(false);
    expect(hasModel(["llama3.2:1b"], "llama3.2:1b")).toBe(true);
    expect(hasModel([], "llama3.2")).toBe(false);
  });
});

describe("setupOllama", () => {
  it("does nothing when Ollama is up and the model is pulled", async () => {
    const m = fakeMachine({ up: true, models: ["llama3.2:latest"], onPath: ["ollama"] });
    const o = options(m);
    const r = await setupOllama(o);
    expect(r.outcome).toBe("ready");
    expect(m.runs).toEqual([]);
    expect(o.asked).toEqual([]);
  });

  it("skip mode never runs anything and explains why", async () => {
    const m = fakeMachine({ onPath: ["brew"] });
    const o = options(m, { mode: "skip", skipReason: "Not an interactive terminal." });
    const r = await setupOllama(o);
    expect(r.outcome).toBe("skipped");
    expect(m.runs).toEqual([]);
    expect(m.detached).toEqual([]);
    expect(o.logs.join("\n")).toContain("Not an interactive terminal.");
    expect(r.hints[0]).toContain("brew install ollama");
  });

  it("--yes on macOS: brew install, start the service, wait, then pull the model", async () => {
    const m = fakeMachine({ onPath: ["brew"] });
    const r = await setupOllama(options(m, { model: "qwen2.5:1.5b" }));
    expect(r.outcome).toBe("ready");
    expect(m.runs.map((x) => x.line)).toEqual([
      "brew install ollama",
      "brew services start ollama",
      "ollama pull qwen2.5:1.5b",
    ]);
    expect(m.runs[2]?.env).toEqual({ OLLAMA_HOST: "http://127.0.0.1:11434" });
  });

  it("asks before each step and runs nothing when the user says no", async () => {
    const m = fakeMachine({ onPath: ["brew"] });
    const o = options(m, { mode: "ask", confirm: async () => false });
    const r = await setupOllama(o);
    expect(r.outcome).toBe("declined");
    expect(m.runs).toEqual([]);
    expect(r.hints.join(" ")).toContain("brew install ollama");
  });

  it("never runs the Linux install script on --yes alone", async () => {
    const m = fakeMachine({ onPath: ["curl"] });
    const o = options(m, { platform: "linux", mode: "accept" });
    const r = await setupOllama(o);
    expect(r.outcome).toBe("declined");
    expect(m.runs).toEqual([]);
    expect(o.logs.join("\n")).toContain("--yes does not run a remote install script");
  });

  it("runs the Linux install script after an interactive yes", async () => {
    const m = fakeMachine({ onPath: ["curl"] });
    const o = options(m, { platform: "linux", mode: "ask" });
    const r = await setupOllama(o);
    expect(r.outcome).toBe("ready");
    expect(o.asked[0]).toContain("official script");
    expect(m.runs.map((x) => x.line)).toEqual([
      "sh -c curl -fsSL https://ollama.com/install.sh | sh",
      "ollama pull llama3.2",
    ]);
  });

  it("prints the download link on macOS without Homebrew", async () => {
    const m = fakeMachine({});
    const o = options(m);
    const r = await setupOllama(o);
    expect(r.outcome).toBe("manual");
    expect(m.runs).toEqual([]);
    expect(o.logs.join("\n")).toContain(OLLAMA_DOWNLOAD_URL);
  });

  it("starts an installed but stopped Ollama in the background", async () => {
    const m = fakeMachine({ onPath: ["ollama"], models: ["llama3.2:latest"] });
    const r = await setupOllama(options(m, { ollamaUrl: "http://127.0.0.1:11500" }));
    expect(r.outcome).toBe("ready");
    expect(m.detached).toEqual([
      { line: "ollama serve", env: { OLLAMA_HOST: "http://127.0.0.1:11500" } },
    ]);
    expect(m.runs).toEqual([]);
  });

  it("won't install anything for an Ollama URL on another machine", async () => {
    const m = fakeMachine({ onPath: ["brew"] });
    const r = await setupOllama(options(m, { ollamaUrl: "http://studio:11434" }));
    expect(r.outcome).toBe("manual");
    expect(m.runs).toEqual([]);
  });

  it("reports a failed install and stops", async () => {
    const m = fakeMachine({ onPath: ["brew"], exit: { "brew install ollama": 1 } });
    const r = await setupOllama(options(m));
    expect(r.outcome).toBe("failed");
    expect(m.runs.map((x) => x.line)).toEqual(["brew install ollama"]);
  });

  it("gives up waiting if Ollama never answers", async () => {
    const m = fakeMachine({ onPath: ["brew"], starts: [] });
    const r = await setupOllama(options(m));
    expect(r.outcome).toBe("failed");
    expect(r.hints.join(" ")).toContain("start Ollama");
  });
});

describe("ollamaMode (CLI)", () => {
  it("maps flags and terminals to a mode", () => {
    expect(ollamaMode(["--no-ollama", "--yes"], true, true).mode).toBe("skip");
    expect(ollamaMode([], true, false).mode).toBe("accept");
    expect(ollamaMode([], false, true).mode).toBe("ask");
    const ci = ollamaMode([], false, false);
    expect(ci.mode).toBe("skip");
    expect(ci.skipReason).toMatch(/--yes/);
  });
});

describe("init writes the local model", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ebbgate-ollama-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const offline = (async () => {
    throw new Error("offline");
  }) as typeof fetch;

  it("records the default model in ebbgate.yaml and LiteLLM, and the config validates", async () => {
    await runInit({ cwd: dir, yes: true, fetch: offline, env: {} });
    const yaml = readFileSync(join(dir, "ebbgate.yaml"), "utf8");
    const vars = parseEnvFile(readFileSync(join(dir, ".env"), "utf8"));
    const cfg = loadConfig(yaml, { ...vars, PAPERCLIP_API_KEY: "k" });
    expect(cfg.local).toEqual({ ollamaUrl: "http://127.0.0.1:11434", model: DEFAULT_OLLAMA_MODEL });
    expect(readFileSync(join(dir, "litellm.config.yaml"), "utf8")).toContain(
      `model: ollama/${DEFAULT_OLLAMA_MODEL}`,
    );
  });

  it("takes --model, and rejects a model name that isn't one", async () => {
    await runInit({
      cwd: dir,
      yes: true,
      fetch: offline,
      env: {},
      answers: { model: "qwen2.5:1.5b" },
    });
    expect(readFileSync(join(dir, "ebbgate.yaml"), "utf8")).toContain('model: "qwen2.5:1.5b"');
    await expect(
      runInit({
        cwd: dir,
        yes: true,
        force: true,
        fetch: offline,
        env: {},
        answers: { model: "x; rm -rf /" },
      }),
    ).rejects.toThrow(/invalid model name/);
  });

  it("is skipped unless the caller asks for it", async () => {
    const r = await runInit({ cwd: dir, yes: true, fetch: offline, env: {} });
    expect(r.ollama).toBeUndefined();
  });

  it("runs setup with --yes through the injected runner and summarises what's left", async () => {
    const m = fakeMachine({ onPath: ["brew"] });
    const r = await runInit({
      cwd: dir,
      yes: true,
      fetch: m.fetchFn,
      env: {},
      ollama: {
        mode: "accept",
        runner: m.runner,
        platform: "darwin",
        log: () => {},
        sleep: async () => {},
      },
    });
    expect(r.ollama?.outcome).toBe("ready");
    expect(r.summary).toContain(
      `Local model: ${DEFAULT_OLLAMA_MODEL} on http://127.0.0.1:11434 (ready)`,
    );

    const skipped = await runInit({
      cwd: dir,
      yes: true,
      force: true,
      fetch: offline,
      env: {},
      ollama: { mode: "skip", runner: fakeMachine({}).runner, platform: "linux", log: () => {} },
    });
    expect(skipped.ollama?.outcome).toBe("skipped");
    expect(skipped.summary).toContain("to do: install Ollama");
  });
});

describe("doctor gives the same hints", () => {
  let dir: string;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "ebbgate-ollama-doc-"));
    await runInit({
      cwd: dir,
      yes: true,
      env: {},
      fetch: (async () => {
        throw new Error("offline");
      }) as typeof fetch,
      answers: { model: "qwen2.5:1.5b" },
    });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const ollamaCheck = async (platform: NodeJS.Platform, fetchFn: typeof fetch) => {
    const report = await runDoctor({ cwd: dir, env: {}, fetch: fetchFn, platform, timeoutMs: 50 });
    const c = report.checks.find((x) => x.id === "ollama");
    if (!c) throw new Error("no ollama check");
    return c;
  };
  const down = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;

  it("uses the platform install hint when Ollama is down", async () => {
    expect((await ollamaCheck("darwin", down)).fix).toContain(ollamaInstallHint("darwin"));
    expect((await ollamaCheck("linux", down)).fix).toContain("https://ollama.com/install.sh");
  });

  it("warns when the model in ebbgate.yaml isn't pulled", async () => {
    const tags = (models: string[]) =>
      (async (input: string | URL | Request) => {
        if (new URL(String(input)).pathname === "/api/tags")
          return Response.json({ models: models.map((name) => ({ name })) });
        throw new TypeError("fetch failed");
      }) as typeof fetch;
    const c = await ollamaCheck("darwin", tags(["llama3.1:latest"]));
    expect(c.status).toBe("warn");
    expect(c.fix).toBe("pull a model: `ollama pull qwen2.5:1.5b`");
    expect((await ollamaCheck("darwin", tags(["qwen2.5:1.5b"]))).status).toBe("pass");
  });
});
