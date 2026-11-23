import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnvFile } from "@ebbgate/agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDoctor } from "../src/doctor.js";
import { runInit } from "../src/init.js";
import { parseServeArgs, resolveServePaths, SERVE_EXIT, startServe } from "../src/serve.js";

const offline = (async () => {
  throw new Error("offline");
}) as typeof fetch;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/** Stand-in for `process` so tests never install real signal handlers. */
function fakeSignals() {
  const em = new EventEmitter();
  return {
    once: em.once.bind(em),
    off: em.off.bind(em),
    emit: (s: NodeJS.Signals) => em.emit(s, s),
    count: (s: string) => em.listenerCount(s),
  } as unknown as Pick<NodeJS.Process, "once" | "off"> & {
    emit(s: NodeJS.Signals): boolean;
    count(s: string): number;
  };
}

describe("parseServeArgs", () => {
  it("reads --config and --env (alias --env-file)", () => {
    expect(parseServeArgs([])).toEqual({});
    expect(parseServeArgs(["--config", "a.yaml", "--env", "s.env"])).toEqual({
      config: "a.yaml",
      envFile: "s.env",
    });
    expect(parseServeArgs(["--env-file", "x"])).toEqual({ envFile: "x" });
  });

  it("rejects unknown options and missing values", () => {
    expect(() => parseServeArgs(["--port", "1"])).toThrow(/unknown option/);
    expect(() => parseServeArgs(["--config"])).toThrow(/needs a value/);
    expect(() => parseServeArgs(["--config", "--env"])).toThrow(/needs a value/);
  });
});

describe("resolveServePaths", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ebbgate-serve-paths-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("finds ./ebbgate.yaml and the .env beside it", () => {
    writeFileSync(join(dir, "ebbgate.yaml"), "x: 1\n");
    expect(resolveServePaths({}, {}, dir)).toEqual({ configPath: join(dir, "ebbgate.yaml") });
    writeFileSync(join(dir, ".env"), "A=1\n");
    expect(resolveServePaths({}, {}, dir).envFile).toBe(join(dir, ".env"));
  });

  it("uses the .env next to an explicit --config, and honours EBBGATE_CONFIG", () => {
    mkdirSync(join(dir, "conf"));
    writeFileSync(join(dir, "conf", "my.yaml"), "x: 1\n");
    writeFileSync(join(dir, "conf", ".env"), "A=1\n");
    const viaFlag = resolveServePaths({ config: "conf/my.yaml" }, {}, dir);
    expect(viaFlag).toEqual({
      configPath: join(dir, "conf", "my.yaml"),
      envFile: join(dir, "conf", ".env"),
    });
    expect(resolveServePaths({}, { EBBGATE_CONFIG: "conf/my.yaml" }, dir)).toEqual(viaFlag);
  });

  it("falls back to ~/.ebbgate/ebbgate.yaml", () => {
    mkdirSync(join(dir, ".ebbgate"));
    writeFileSync(join(dir, ".ebbgate", "ebbgate.yaml"), "x: 1\n");
    const cwd = mkdtempSync(join(tmpdir(), "ebbgate-serve-cwd-"));
    try {
      expect(resolveServePaths({}, { HOME: dir }, cwd).configPath).toBe(
        join(dir, ".ebbgate", "ebbgate.yaml"),
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("explains what to do when files are missing", () => {
    expect(() => resolveServePaths({}, { HOME: dir }, dir)).toThrow(/ebbgate init/);
    expect(() => resolveServePaths({ config: "nope.yaml" }, {}, dir)).toThrow(/config not found/);
    writeFileSync(join(dir, "ebbgate.yaml"), "x: 1\n");
    expect(() => resolveServePaths({ envFile: "missing.env" }, {}, dir)).toThrow(
      /env file not found/,
    );
  });
});

describe("ebbgate serve", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ebbgate-serve-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function initHere(): Promise<{ port: number; vars: Record<string, string> }> {
    const port = await freePort();
    await runInit({
      cwd: dir,
      yes: true,
      fetch: offline,
      env: {},
      answers: {
        nodes: [{ id: "mini", prefer: true }],
        dispatcherPort: port,
        publicUrl: `http://127.0.0.1:${port}`,
      },
    });
    return { port, vars: parseEnvFile(readFileSync(join(dir, ".env"), "utf8")) };
  }

  it("starts from `ebbgate init` output, prints the URL, and stops cleanly on SIGTERM", async () => {
    const { port, vars } = await initHere();
    const lines: string[] = [];
    const signals = fakeSignals();
    const handle = await startServe([], {
      cwd: dir,
      // Only what init leaves for the user to add, plus quiet logs; secrets come from .env.
      env: { PAPERCLIP_API_KEY: "pc-key-from-env", LOG_LEVEL: "silent", HOME: dir },
      write: (l) => lines.push(l),
      signals,
    });
    expect(handle.code).toBe(SERVE_EXIT.OK);
    const out = lines.join("\n");
    expect(out).toContain(`listening on http://127.0.0.1:${port}`);
    expect(out).toContain(`http://127.0.0.1:${port}/run`);
    expect(out).toContain(join(dir, "ebbgate.yaml"));
    expect(out).toContain(join(dir, ".env"));
    // Paths and URLs only: no secret value reaches the terminal.
    for (const value of [...Object.values(vars), "pc-key-from-env"]) {
      expect(out).not.toContain(value);
    }

    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(health.status).toBe(200);
    // Authenticated with the secret init wrote: the .env really was loaded.
    const status = await fetch(`http://127.0.0.1:${port}/status`, {
      headers: { authorization: `Bearer ${vars.EG_PAPERCLIP_SECRET}` },
    });
    expect(status.status).toBe(200);
    const wrong = await fetch(`http://127.0.0.1:${port}/status`, {
      headers: { authorization: "Bearer not-the-secret-0123456789" },
    });
    expect(wrong.status).toBe(401);
    // The database defaults to ./data under the folder it was started in.
    expect(existsSync(join(dir, "data"))).toBe(true);
    expect(readdirSync(join(dir, "data")).some((f) => f.startsWith("ebbgate.db"))).toBe(true);

    expect(signals.count("SIGTERM")).toBe(1);
    signals.emit("SIGTERM");
    await expect(handle.done).resolves.toBe(SERVE_EXIT.OK);
    expect(handle.server?.listening).toBe(false);
    // Both handlers are removed once shutdown starts.
    expect(signals.count("SIGINT")).toBe(0);
    expect(signals.count("SIGTERM")).toBe(0);
    await expect(fetch(`http://127.0.0.1:${port}/healthz`)).rejects.toThrow();
  });

  it("lets the process environment override the .env file, like node --env-file", async () => {
    const { port } = await initHere();
    const override = "override-secret-0123456789abcdef";
    const signals = fakeSignals();
    const handle = await startServe([], {
      cwd: dir,
      env: {
        PAPERCLIP_API_KEY: "k",
        EG_PAPERCLIP_SECRET: override,
        LOG_LEVEL: "silent",
        HOME: dir,
      },
      write: () => {},
      signals,
    });
    try {
      expect(handle.code).toBe(SERVE_EXIT.OK);
      const res = await fetch(`http://127.0.0.1:${port}/status`, {
        headers: { authorization: `Bearer ${override}` },
      });
      expect(res.status).toBe(200);
    } finally {
      signals.emit("SIGINT");
      await handle.done;
    }
  });

  it("fails with exit 1 and a one-line hint when the config is missing or a secret is unset", async () => {
    const lines: string[] = [];
    const missing = await startServe([], {
      cwd: dir,
      env: { HOME: dir },
      write: (l) => lines.push(l),
    });
    expect(missing.code).toBe(SERVE_EXIT.ERROR);
    expect(lines.join("\n")).toMatch(/ebbgate init/);

    await initHere();
    lines.length = 0;
    // PAPERCLIP_API_KEY is not in .env (init never stores it) nor in the environment.
    const unset = await startServe([], {
      cwd: dir,
      env: { HOME: dir },
      write: (l) => lines.push(l),
    });
    expect(unset.code).toBe(SERVE_EXIT.ERROR);
    expect(lines.join("\n")).toContain("PAPERCLIP_API_KEY");
    expect(lines.join("\n")).not.toMatch(/\n\s+at /);
  });

  it("exits 2 on a bad flag", async () => {
    const lines: string[] = [];
    const h = await startServe(["--bogus"], { cwd: dir, env: {}, write: (l) => lines.push(l) });
    expect(h.code).toBe(SERVE_EXIT.USAGE);
    expect(lines.join("\n")).toMatch(/usage: ebbgate serve/);
  });
});

describe("bundling", () => {
  it("the CLI never imports the self-starting @ebbgate/dispatcher entry", () => {
    const srcDir = new URL("../src/", import.meta.url);
    const files = readdirSync(srcDir, { recursive: true, withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith(".ts"))
      .map((d) => join(d.parentPath, d.name));
    for (const file of files) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/from "@ebbgate\/dispatcher"/);
    }
  });
});

describe("doctor", () => {
  it("points at `ebbgate serve` when the dispatcher is down", async () => {
    await runInit({ cwd: dir2(), yes: true, fetch: offline, env: {} });
    const report = await runDoctor({ cwd: lastDir, env: {}, fetch: offline, timeoutMs: 50 });
    const check = report.checks.find((c) => c.id === "dispatcher");
    expect(check?.status).toBe("fail");
    expect(check?.fix).toContain("ebbgate serve");
    rmSync(lastDir, { recursive: true, force: true });
  });
});

let lastDir = "";
function dir2(): string {
  lastDir = mkdtempSync(join(tmpdir(), "ebbgate-serve-doctor-"));
  return lastDir;
}
