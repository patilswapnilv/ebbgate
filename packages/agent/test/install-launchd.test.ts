import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inferNodeId, installAgent, type LaunchctlRunner, uninstallAgent } from "../src/install.js";
import { LAUNCH_AGENT_LABEL } from "../src/paths.js";

const NODE_TOKEN = "node-mini-token-0123456789abcdef";

const CONFIG = `server: { port: 8790, publicUrl: "http://127.0.0.1:8790" }
nodes:
  mini: { runner: "http://127.0.0.1:8787", token: "\${EG_NODE_MINI_TOKEN}", prefer: true }
paperclip:
  apiUrl: "http://127.0.0.1:3100"
  apiKey: "\${PAPERCLIP_API_KEY}"
  sharedSecret: "\${EG_PAPERCLIP_SECRET}"
policies:
  - default: { available: local, busy: local-low, offline: defer }
`;

/** Records launchctl calls; `fail` lists subcommands that should reject. */
function fakeLaunchctl(fail: string[] = []): { run: LaunchctlRunner; calls: string[] } {
  const calls: string[] = [];
  const run: LaunchctlRunner = async (cmd, args) => {
    calls.push([cmd, ...args].join(" "));
    if (fail.includes(args[0] ?? "")) throw new Error(`${args[0]} failed`);
    return { stdout: "", stderr: "" };
  };
  return { run, calls };
}

describe("ebbgate agent install / uninstall (launchd, injected)", () => {
  let dir: string;
  let config: string;
  let envFile: string;
  let home: string;
  let plistPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ebbgate-launchd-"));
    config = join(dir, "ebbgate.yaml");
    envFile = join(dir, ".env");
    home = join(dir, "home", ".ebbgate");
    plistPath = join(dir, "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`);
    writeFileSync(config, CONFIG);
    writeFileSync(envFile, `EG_NODE_MINI_TOKEN=${NODE_TOKEN}\n`, { mode: 0o600 });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const install = (
    launchctl: LaunchctlRunner,
    extra: Partial<Parameters<typeof installAgent>[0]> = {},
  ) =>
    installAgent({
      node: "mini",
      configPath: config,
      envFile,
      plistPath,
      ebbgateDir: home,
      uid: 501,
      platform: "darwin",
      nodeBin: "/opt/homebrew/bin/node",
      cliPath: "/opt/homebrew/lib/node_modules/ebbgate/dist/cli.js",
      env: { PATH: "/usr/bin:/bin", HOME: join(dir, "home") },
      exec: launchctl,
      ...extra,
    });

  it("writes the plist and settings, then reloads the job via launchctl", async () => {
    const lc = fakeLaunchctl();
    const result = await install(lc.run);

    expect(result.plistPath).toBe(plistPath);
    const xml = readFileSync(plistPath, "utf8");
    expect(xml).toContain(`<string>${LAUNCH_AGENT_LABEL}</string>`);
    expect(xml).toContain("<string>/opt/homebrew/bin/node</string>");
    expect(xml).toContain(`<string>${config}</string>`);
    expect(xml).toContain(`<string>${envFile}</string>`);
    expect(xml).toContain(`<string>${home}</string>`); // WorkingDirectory
    expect(xml).not.toContain(NODE_TOKEN); // secrets stay in the env file

    expect(readFileSync(join(home, "node"), "utf8")).toBe("mini\n");
    const saved = JSON.parse(readFileSync(join(home, "agent.json"), "utf8"));
    expect(saved).toMatchObject({ node: "mini", configPath: config, envFile });
    expect(statSync(join(home, "agent.json")).mode & 0o777).toBe(0o600);

    expect(lc.calls).toEqual([
      `launchctl bootout gui/501/${LAUNCH_AGENT_LABEL}`,
      `launchctl bootstrap gui/501 ${plistPath}`,
    ]);
  });

  it("falls back to unload/load on older launchctl", async () => {
    const lc = fakeLaunchctl(["bootout", "bootstrap", "unload"]);
    await install(lc.run);
    expect(lc.calls).toEqual([
      `launchctl bootout gui/501/${LAUNCH_AGENT_LABEL}`,
      `launchctl unload ${plistPath}`,
      `launchctl bootstrap gui/501 ${plistPath}`,
      `launchctl load ${plistPath}`,
    ]);
  });

  it("refuses on a non-macOS platform before writing anything", async () => {
    const lc = fakeLaunchctl();
    await expect(install(lc.run, { platform: "linux" })).rejects.toThrow(/macOS launchd/);
    expect(existsSync(plistPath)).toBe(false);
    expect(existsSync(home)).toBe(false);
    expect(lc.calls).toEqual([]);
  });

  it("uninstall boots the job out and removes the plist", async () => {
    await install(fakeLaunchctl().run);
    const lc = fakeLaunchctl();
    const result = await uninstallAgent({ plistPath, exec: lc.run, uid: 501 });
    expect(result).toEqual({ plistPath, removed: true });
    expect(existsSync(plistPath)).toBe(false);
    expect(lc.calls).toEqual([`launchctl bootout gui/501/${LAUNCH_AGENT_LABEL}`]);

    const again = await uninstallAgent({
      plistPath,
      exec: fakeLaunchctl(["bootout", "unload"]).run,
    });
    expect(again.removed).toBe(false);
  });

  it("infers the node id when the config has exactly one node", () => {
    expect(inferNodeId(config)).toBe("mini");
    writeFileSync(
      config,
      CONFIG.replace("nodes:\n", 'nodes:\n  mbp: { runner: "http://mbp:8787", token: "x" }\n'),
    );
    expect(() => inferNodeId(config)).toThrow(/several nodes \(mbp, mini\); pass --node/);
    writeFileSync(config, "nodes: {}\n");
    expect(() => inferNodeId(config)).toThrow(/no nodes/);
  });
});
