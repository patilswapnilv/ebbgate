import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadAgentRuntime, resolveConfigPath } from "../src/config.js";
import { loadEnvFile, parseEnvFile } from "../src/envfile.js";
import {
  buildLaunchAgentPlist,
  installAgent,
  preflightCredentials,
  resolveInstallSettings,
} from "../src/install.js";
import { printStatus } from "../src/status.js";

const NODE_TOKEN = "node-mini-token-0123456789abcdef";
const PAPERCLIP_KEY = "pc-live-DISPATCHER-ONLY-SECRET";

/** A dispatcher config: references node, dispatcher and notifier secrets. */
const CONFIG = `server: { port: 8790, publicUrl: "http://cloud:8790" }
nodes:
  mini: { runner: "http://mini:8787", token: "\${EG_NODE_MINI_TOKEN}" }
  mbp:  { runner: "http://mbp:8787",  token: "\${EG_NODE_MBP_TOKEN}" }
cloud: { runner: "http://c:1" }
paperclip:
  apiUrl: "http://paperclip:3100"
  apiKey: "\${PAPERCLIP_API_KEY}"
  sharedSecret: "\${EG_PAPERCLIP_SECRET}"
policies:
  - default: { available: defer, busy: defer, offline: defer }
notify:
  telegram: { botToken: "\${TG_BOT_TOKEN}", chatId: "1" }
`;

describe("env files", () => {
  it("parses KEY=value lines, export, quotes and comments without evaluating", () => {
    expect(
      parseEnvFile(
        [
          "# comment",
          "EG_NODE_MINI_TOKEN=abc123",
          'export QUOTED="with spaces # not a comment"',
          "SINGLE='x=y'",
          "INLINE=value # trailing comment",
          "EMPTY=",
          "not a line",
          "1BAD=x",
          // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell syntax under test
          "EXPANSION=$HOME/${USER}",
        ].join("\n"),
      ),
    ).toEqual({
      EG_NODE_MINI_TOKEN: "abc123",
      QUOTED: "with spaces # not a comment",
      SINGLE: "x=y",
      INLINE: "value",
      EMPTY: "",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: values are never expanded
      EXPANSION: "$HOME/${USER}",
    });
  });
});

describe("node runtime secrets", () => {
  let dir: string;
  let config: string;
  let envFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ebbgate-secrets-"));
    config = join(dir, "ebbgate.yaml");
    envFile = join(dir, "node.env");
    writeFileSync(config, CONFIG);
    writeFileSync(envFile, `EG_NODE_MINI_TOKEN=${NODE_TOKEN}\n`);
    chmodSync(envFile, 0o600);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** What launchd gives the job: no shell profile, only the plist's variables. */
  const launchdEnv = (extra: Record<string, string> = {}) => ({
    PATH: "/usr/bin:/bin",
    EBBGATE_NODE: "mini",
    EBBGATE_CONFIG: config,
    EBBGATE_ENV_FILE: envFile,
    ...extra,
  });

  it("starts from a launchd-style environment with only the node token available", () => {
    const rt = loadAgentRuntime(launchdEnv(), { local: {} });
    expect(rt.token).toBe(NODE_TOKEN);
    expect(rt.envFile).toBe(envFile);
    // Dispatcher secrets were never needed (PAPERCLIP_API_KEY, TG_BOT_TOKEN, mbp's token).
    expect(rt.statusToken).toBeUndefined();
  });

  it("starts from a clean shell using a .env next to the config", () => {
    writeFileSync(join(dir, ".env"), `EG_NODE_MINI_TOKEN=${NODE_TOKEN}\n`);
    chmodSync(join(dir, ".env"), 0o600);
    const rt = loadAgentRuntime(
      { PATH: "/usr/bin", EBBGATE_NODE: "mini", EBBGATE_CONFIG: config },
      { local: {} },
    );
    expect(rt.token).toBe(NODE_TOKEN);
  });

  it("lets the process environment override the file", () => {
    const rt = loadAgentRuntime(launchdEnv({ EG_NODE_MINI_TOKEN: "override-token-0123456789" }), {
      local: {},
    });
    expect(rt.token).toBe("override-token-0123456789");
  });

  it("names the missing variable and where to set it, never a value", () => {
    writeFileSync(envFile, `PAPERCLIP_API_KEY=${PAPERCLIP_KEY}\n`);
    expect(() => loadAgentRuntime(launchdEnv(), { local: {} })).toThrow(
      new RegExp(`needs EG_NODE_MINI_TOKEN: set it in the environment or ${envFile}`),
    );
    try {
      loadAgentRuntime(launchdEnv(), { local: {} });
    } catch (err) {
      expect(String(err)).not.toContain(PAPERCLIP_KEY);
    }
  });

  it("fails clearly when an explicitly chosen env file is missing", () => {
    expect(() =>
      loadAgentRuntime(launchdEnv({ EBBGATE_ENV_FILE: join(dir, "nope.env") }), { local: {} }),
    ).toThrow(/env file not found/);
  });

  it("warns when the env file is readable by other users", () => {
    chmodSync(envFile, 0o644);
    const warnings: string[] = [];
    loadAgentRuntime(launchdEnv(), { local: {}, onWarning: (m) => warnings.push(m) });
    expect(warnings[0]).toMatch(/chmod 600/);
    expect(loadEnvFile(envFile).warning).toBeTruthy();
  });

  it("status works on a node without the dispatcher's admin secret", async () => {
    let called = false;
    const out = await printStatus(launchdEnv(), (async () => {
      called = true;
      return new Response("{}");
    }) as typeof fetch);
    expect(called).toBe(false);
    expect(out).toMatch(/skipped \(no admin secret/);
  });

  describe("install", () => {
    it("records the env-file path in the plist, never secret values", () => {
      const settings = resolveInstallSettings({ configPath: config, envFile }, {}, {});
      preflightCredentials("mini", settings, {});
      const xml = buildLaunchAgentPlist({
        node: "mini",
        settings,
        env: { PATH: "/usr/bin", EG_NODE_MINI_TOKEN: NODE_TOKEN, PAPERCLIP_API_KEY: PAPERCLIP_KEY },
        nodeBin: "/usr/local/bin/node",
        cliPath: "/opt/ebbgate/cli.js",
      });
      expect(xml).toContain("<key>EBBGATE_ENV_FILE</key>");
      expect(xml).toContain(`<string>${envFile}</string>`);
      expect(xml).not.toContain(NODE_TOKEN);
      expect(xml).not.toContain(PAPERCLIP_KEY);
    });

    it("refuses to install when launchd would not find the node token", () => {
      // The installing shell has the token, but launchd will not inherit it.
      const settings = resolveInstallSettings({ configPath: config }, {}, {});
      expect(() =>
        preflightCredentials("mini", { ...settings }, { EG_NODE_MINI_TOKEN: NODE_TOKEN }),
      ).toThrow(/needs EG_NODE_MINI_TOKEN/);
    });

    it("installAgent stops before writing the plist or calling launchctl", async () => {
      const plistPath = join(dir, "agent.plist");
      const calls: string[] = [];
      await expect(
        installAgent({
          node: "mini",
          configPath: config,
          env: { PATH: "/usr/bin", EG_NODE_MINI_TOKEN: NODE_TOKEN }, // shell-only token
          plistPath,
          // biome-ignore lint/suspicious/noExplicitAny: launchctl stub
          exec: (async (cmd: string) => calls.push(cmd)) as any,
        }),
      ).rejects.toThrow(/needs EG_NODE_MINI_TOKEN/);
      expect(existsSync(plistPath)).toBe(false);
      expect(calls).toEqual([]);
    });

    it.each([
      ["--config", { configPath: "/nope/ebbgate.yaml" }, {}, {}],
      ["EBBGATE_CONFIG", {}, { EBBGATE_CONFIG: "/nope/ebbgate.yaml" }, {}],
      ["saved configPath", {}, {}, { configPath: "/nope/ebbgate.yaml" }],
    ] as const)(
      "rejects a missing config path from %s before writing anything",
      (_src, opts, env, local) => {
        expect(() => resolveInstallSettings(opts, env, local)).toThrow(/config not found/);
      },
    );

    it("rejects a missing --env-file", () => {
      expect(() =>
        resolveInstallSettings({ configPath: config, envFile: join(dir, "nope.env") }, {}, {}),
      ).toThrow(/env file not found/);
    });

    it("still resolves an existing config through the fallbacks", () => {
      expect(resolveConfigPath({ EBBGATE_CONFIG: config }, {})).toBe(config);
    });
  });
});
