import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@ebbgate/core";
import { afterEach, describe, expect, it } from "vitest";
import { renderEbbgateYaml } from "../src/generate/ebbgate-yaml.js";
import { renderEnvExample } from "../src/generate/env-example.js";
import { renderLitellmConfig } from "../src/generate/litellm.js";
import { envKeyForNodeToken, generateSecret } from "../src/generate/secrets.js";
import { runInit } from "../src/init.js";

describe("generators", () => {
  it("renders secrets and env keys", () => {
    expect(generateSecret().length).toBeGreaterThanOrEqual(16);
    expect(envKeyForNodeToken("mini")).toBe("EG_NODE_MINI_TOKEN");
    expect(envKeyForNodeToken("mac-studio")).toBe("EG_NODE_MAC_STUDIO_TOKEN");
  });

  it("renders litellm aliases from §9", () => {
    const yaml = renderLitellmConfig("http://127.0.0.1:11434");
    expect(yaml).toContain("private-fast");
    expect(yaml).toContain("private-smart");
    expect(yaml).toContain("internal-smart");
    expect(yaml).toContain("cloud-reason");
    expect(yaml).toContain("cloud-cheap");
    expect(yaml).toContain("api_base: http://127.0.0.1:11434");
  });

  it("renders ebbgate.yaml that loadConfig accepts", () => {
    const yaml = renderEbbgateYaml({
      publicUrl: "http://127.0.0.1:8790",
      dispatcherPort: 8790,
      nodes: [{ id: "mini", prefer: true }],
      cloudRunner: "http://127.0.0.1:18789/paperclip",
      paperclipApiUrl: "http://127.0.0.1:3100",
      ollamaUrl: "http://127.0.0.1:11434",
      litellmUrl: "http://127.0.0.1:4000",
      agents: [
        { id: "agent_inbox", tier: "private" },
        { id: "agent_ops", tier: "internal" },
      ],
      includeNotifyPlaceholders: true,
    });

    const cfg = loadConfig(yaml, {
      EG_NODE_MINI_TOKEN: "mini-token-0123456789ab",
      PAPERCLIP_API_KEY: "pc-key",
      EG_PAPERCLIP_SECRET: "shared-secret-012345",
    });
    expect(cfg.nodes.mini?.prefer).toBe(true);
    expect(cfg.agents.agent_inbox?.tier).toBe("private");
  });

  it("renders .env.example without real secrets", () => {
    const env = renderEnvExample([{ id: "mini" }, { id: "mbp" }]);
    expect(env).toContain("EG_NODE_MINI_TOKEN=");
    expect(env).toContain("EG_NODE_MBP_TOKEN=");
    expect(env).toContain("PAPERCLIP_API_KEY=");
    expect(env).not.toMatch(/sk_pap_[a-zA-Z0-9]{20,}/);
  });
});

describe("runInit --yes", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it("writes the config, secrets and example files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ebbgate-init-"));
    dirs.push(dir);
    const result = await runInit({
      cwd: dir,
      yes: true,
      fetch: async () => {
        throw new Error("offline");
      },
    });
    expect(result.files).toHaveLength(4);
    expect(readFileSync(join(dir, "ebbgate.yaml"), "utf8")).toContain("publicUrl:");
    expect(readFileSync(join(dir, ".env.example"), "utf8")).toContain("EG_PAPERCLIP_SECRET=");
    expect(readFileSync(join(dir, "litellm.config.yaml"), "utf8")).toContain("private-fast");
    expect(result.sharedSecret.length).toBeGreaterThanOrEqual(16);
  });
});
