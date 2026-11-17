import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isEntrypoint } from "@ebbgate/agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { bindHostLine } from "../src/generate/ebbgate-yaml.js";
import { renderLitellmConfig } from "../src/generate/litellm.js";
import { ExistingConfigError, runInit } from "../src/init.js";

const repo = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));

type LitellmConfig = {
  model_list: Array<{ model_name: string; litellm_params: { model: string } }>;
  router_settings?: { fallbacks?: Array<Record<string, string[]>>; routing_strategy?: string };
  general_settings?: { master_key?: string };
};

describe("LiteLLM config is local-first and authenticated", () => {
  const cfg = parse(renderLitellmConfig("http://127.0.0.1:11434")) as LitellmConfig;
  const deployments = (name: string) =>
    cfg.model_list.filter((m) => m.model_name === name).map((m) => m.litellm_params.model);
  const fallbacks = Object.assign({}, ...(cfg.router_settings?.fallbacks ?? []));

  it("serves internal-smart from Ollama only, with cloud as an explicit fallback", () => {
    expect(deployments("internal-smart")).toEqual(["ollama/llama3.1"]);
    expect(fallbacks["internal-smart"]).toEqual(["internal-cloud"]);
    expect(deployments("internal-cloud").every((m) => !m.startsWith("ollama/"))).toBe(true);
    expect(cfg.router_settings?.routing_strategy).toBeUndefined();
  });

  it("keeps private aliases local, with no fallback", () => {
    for (const alias of ["private-fast", "private-smart"]) {
      expect(deployments(alias).every((m) => m.startsWith("ollama/"))).toBe(true);
      expect(fallbacks[alias]).toBeUndefined();
    }
  });

  it("requires a master key", () => {
    expect(cfg.general_settings?.master_key).toBe("os.environ/LITELLM_MASTER_KEY");
  });

  it("the compose quickstart config matches the generator", () => {
    const strip = (s: string) =>
      s
        .split("\n")
        .filter((l) => !l.startsWith("#"))
        .join("\n")
        .trim();
    const checkedIn = readFileSync(repo("examples/compose/litellm.config.yaml"), "utf8");
    expect(strip(checkedIn)).toBe(strip(renderLitellmConfig("http://host.docker.internal:11434")));
  });
});

describe("compose quickstart", () => {
  type Service = { ports?: string[]; extra_hosts?: string[]; environment?: Record<string, string> };
  const compose = parse(readFileSync(repo("examples/compose/docker-compose.yml"), "utf8")) as {
    services: Record<string, Service>;
  };

  it("maps host.docker.internal for native Docker Engine", () => {
    for (const name of ["dispatcher", "litellm"]) {
      expect(compose.services[name]?.extra_hosts).toContain("host.docker.internal:host-gateway");
    }
  });

  it("publishes LiteLLM on loopback only and requires its master key", () => {
    const litellm = compose.services.litellm;
    expect(litellm?.ports).toEqual(["127.0.0.1:4000:4000"]);
    expect(litellm?.environment?.LITELLM_MASTER_KEY).toMatch(/^\$\{LITELLM_MASTER_KEY:\?/);
    const env = readFileSync(repo("examples/compose/.env.example"), "utf8");
    expect(env).toMatch(/^LITELLM_MASTER_KEY=sk-/m);
  });

  it("documents commands that work from a clean checkout", () => {
    const readme = readFileSync(repo("examples/compose/README.md"), "utf8");
    expect(readme).not.toContain("--filter @ebbgate/cli exec");
    expect(readme).toContain("pnpm ebbgate agent install");
    const pkg = JSON.parse(readFileSync(repo("package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.ebbgate).toBe("node packages/cli/dist/cli.js");
  });
});

describe("generated dispatcher bind address", () => {
  it("stays on loopback only for a loopback publicUrl", () => {
    expect(bindHostLine("http://127.0.0.1:8790")).toMatch(/^host: 127\.0\.0\.1/);
    expect(bindHostLine("http://localhost:8790")).toMatch(/^host: 127\.0\.0\.1/);
  });
  it("listens on every interface when nodes must reach it", () => {
    expect(bindHostLine("http://cloud:8790")).toMatch(/^host: 0\.0\.0\.0/);
    expect(bindHostLine("http://100.64.0.2:8790")).toMatch(/^host: 0\.0\.0\.0/);
  });
});

describe("ebbgate init never overwrites silently", () => {
  let dir: string;
  const offline = (async () => new Response("", { status: 503 })) as typeof fetch;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ebbgate-init-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("refuses to replace existing files without --force", async () => {
    writeFileSync(join(dir, "ebbgate.yaml"), "# my nodes and tiers\n");
    await expect(runInit({ cwd: dir, yes: true, fetch: offline })).rejects.toBeInstanceOf(
      ExistingConfigError,
    );
    expect(readFileSync(join(dir, "ebbgate.yaml"), "utf8")).toBe("# my nodes and tiers\n");
  });

  it("replaces them with --force", async () => {
    writeFileSync(join(dir, "ebbgate.yaml"), "# old\n");
    await runInit({ cwd: dir, yes: true, force: true, fetch: offline });
    expect(readFileSync(join(dir, "ebbgate.yaml"), "utf8")).toContain(
      "Generated by `ebbgate init`",
    );
  });

  it("writes freely into an empty directory", async () => {
    const result = await runInit({ cwd: dir, yes: true, fetch: offline });
    expect(result.files).toHaveLength(3);
  });
});

describe("CLI entrypoint through a symlink", () => {
  it("is detected when invoked via a bin symlink", () => {
    const dir = mkdtempSync(join(tmpdir(), "ebbgate-bin-"));
    try {
      const real = join(dir, "cli.js");
      const link = join(dir, "ebbgate");
      writeFileSync(real, "");
      symlinkSync(real, link);
      expect(isEntrypoint(pathToFileURL(real).href, link)).toBe(true);
      expect(isEntrypoint(pathToFileURL(real).href, join(dir, "other.js"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
