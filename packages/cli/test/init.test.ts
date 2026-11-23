import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnvFile } from "@ebbgate/agent";
import { loadConfig, resolveTier } from "@ebbgate/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { maskSecret } from "../src/generate/secrets-file.js";
import { defaultNodeId, runInit } from "../src/init.js";

const offline = (async () => {
  throw new Error("offline");
}) as typeof fetch;

describe("ebbgate init --yes (secure defaults)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ebbgate-init-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const init = (extra: Parameters<typeof runInit>[0] = {}) =>
    runInit({ cwd: dir, yes: true, fetch: offline, env: {}, ...extra });

  it("writes secrets to .env with mode 600 and a config that validates with them", async () => {
    const result = await init({ answers: { nodes: [{ id: "mini", prefer: true }] } });
    const envPath = join(dir, ".env");
    expect(result.secretsFile).toBe(envPath);
    expect(statSync(envPath).mode & 0o777).toBe(0o600);

    const vars = parseEnvFile(readFileSync(envPath, "utf8"));
    expect(vars.EG_PAPERCLIP_SECRET).toBe(result.sharedSecret);
    expect(vars.EG_NODE_MINI_TOKEN?.length).toBeGreaterThanOrEqual(16);
    expect(vars.PAPERCLIP_API_KEY).toBeUndefined();

    const cfg = loadConfig(readFileSync(join(dir, "ebbgate.yaml"), "utf8"), {
      ...vars,
      PAPERCLIP_API_KEY: "pc-key",
    });
    // No cloud runner unless configured; nothing is routed to the cloud.
    expect(cfg.cloud).toBeUndefined();
    expect(JSON.stringify(cfg.policies)).not.toContain('"cloud"');
    // No agents listed: every agent, known or not, counts as private.
    expect(cfg.agents).toEqual({});
    expect(resolveTier("agent_anything", cfg)).toBe("private");
    // One-machine setup: the dispatcher reaches the runner on loopback.
    expect(cfg.nodes.mini?.runner).toBe("http://127.0.0.1:8787");
    expect(cfg.server.host).toBe("127.0.0.1");
  });

  it("never prints a secret in full", async () => {
    const result = await init();
    for (const secret of [result.sharedSecret, ...Object.values(result.nodeSecrets)]) {
      expect(result.summary).not.toContain(secret);
      expect(result.summary).toContain(maskSecret(secret));
    }
    expect(result.summary).toMatch(/Cloud runner: none/);
    expect(result.summary).toContain("ebbgate doctor");
  });

  it("uses a cloud runner only when one is given", async () => {
    await init({ answers: { cloudRunner: "https://cloud.example/paperclip" } });
    const vars = parseEnvFile(readFileSync(join(dir, ".env"), "utf8"));
    const cfg = loadConfig(readFileSync(join(dir, "ebbgate.yaml"), "utf8"), {
      ...vars,
      PAPERCLIP_API_KEY: "pc-key",
    });
    expect(cfg.cloud?.runner).toBe("https://cloud.example/paperclip");
    // Private work still never goes there (validated at load).
    const privateRule = cfg.policies.find((r) => "match" in r && r.match.tier === "private");
    expect(JSON.stringify(privateRule)).not.toContain('"cloud"');
  });

  it("stores PAPERCLIP_API_KEY from the environment in .env, not in the yaml", async () => {
    await init({ env: { PAPERCLIP_API_KEY: "pc-live-0123456789" } });
    expect(readFileSync(join(dir, ".env"), "utf8")).toContain(
      "PAPERCLIP_API_KEY=pc-live-0123456789",
    );
    expect(readFileSync(join(dir, "ebbgate.yaml"), "utf8")).not.toContain("pc-live");
  });

  it("--force keeps existing secrets so running nodes keep working", async () => {
    const first = await init({ answers: { nodes: [{ id: "mini" }] } });
    const second = await init({ force: true, answers: { nodes: [{ id: "mini" }] } });
    expect(second.sharedSecret).toBe(first.sharedSecret);
    expect(second.nodeSecrets).toEqual(first.nodeSecrets);
    expect(statSync(join(dir, ".env")).mode & 0o777).toBe(0o600);
  });

  it("tightens a loose existing .env to 600 on --force", async () => {
    writeFileSync(join(dir, ".env"), "EG_PAPERCLIP_SECRET=keep-this-secret-0123\n", {
      mode: 0o644,
    });
    const result = await init({ force: true });
    expect(result.sharedSecret).toBe("keep-this-secret-0123");
    expect(statSync(join(dir, ".env")).mode & 0o777).toBe(0o600);
  });

  it("adds .env to an existing .gitignore, and never creates one", async () => {
    await init();
    expect(existsSync(join(dir, ".gitignore"))).toBe(false);

    const other = mkdtempSync(join(tmpdir(), "ebbgate-init-git-"));
    try {
      writeFileSync(join(other, ".gitignore"), "node_modules");
      await runInit({ cwd: other, yes: true, fetch: offline, env: {} });
      expect(readFileSync(join(other, ".gitignore"), "utf8")).toBe("node_modules\n.env\n");
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});

describe("defaultNodeId", () => {
  it("derives a valid node id from the hostname", () => {
    expect(defaultNodeId("Swapnils-MacBook-Pro.local")).toBe("swapnils-macbook-pro");
    expect(defaultNodeId("my_mac mini")).toBe("my-mac-mini");
    expect(defaultNodeId("---")).toBe("mini");
    expect(defaultNodeId("a".repeat(40))).toHaveLength(32);
  });
});
