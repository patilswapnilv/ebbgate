import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type CheckResult,
  checkNode,
  type DoctorReport,
  formatDoctorReport,
  runDoctor,
  runDoctorCommand,
} from "../src/doctor.js";
import { runInit } from "../src/init.js";

const NOW = new Date("2026-11-23T10:00:00Z");
const PAPERCLIP_KEY = "pc-live-key-0123456789";

type Route = (url: URL, init?: RequestInit) => Response | Promise<Response>;

/** A fake network: dispatcher, Ollama and Paperclip, each overridable. */
function fakeNet(overrides: Record<string, Route> = {}, secret?: () => string) {
  const calls: string[] = [];
  const routes: Record<string, Route> = {
    "127.0.0.1:8790/healthz": () => Response.json({ ok: true }),
    "127.0.0.1:8790/status": (_u, init) => {
      const auth = new Headers(init?.headers).get("authorization");
      if (secret && auth !== `Bearer ${secret()}`) return Response.json({}, { status: 401 });
      return Response.json({
        nodes: [{ node: "mini", state: "available", lastSeenAt: "2026-11-23T09:59:40Z" }],
      });
    },
    "127.0.0.1:11434/api/tags": () => Response.json({ models: [{ name: "llama3.2" }] }),
    "127.0.0.1:3100/api/health": () => Response.json({ ok: true }),
    ...overrides,
  };
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(`${url.host}${url.pathname}`);
    const route = routes[`${url.host}${url.pathname}`];
    if (!route) throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
    return route(url, init);
  }) as typeof fetch;
  return { fetchFn, calls };
}

const down: Route = () => {
  throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
};

function byId(report: DoctorReport, id: string): CheckResult {
  const c = report.checks.find((x) => x.id === id);
  if (!c) throw new Error(`no check ${id}`);
  return c;
}

describe("ebbgate doctor", () => {
  let dir: string;
  let secret = "";
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "ebbgate-doctor-"));
    const r = await runInit({
      cwd: dir,
      yes: true,
      env: { PAPERCLIP_API_KEY: PAPERCLIP_KEY },
      fetch: (async () => {
        throw new Error("offline");
      }) as typeof fetch,
      answers: { nodes: [{ id: "mini", prefer: true }] },
    });
    secret = r.sharedSecret;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const doctor = (net = fakeNet({}, () => secret), env: NodeJS.ProcessEnv = {}) =>
    runDoctor({ cwd: dir, env, fetch: net.fetchFn, now: () => NOW, nodeVersion: "22.12.0" });

  it("passes every check on a fresh init with everything running", async () => {
    const report = await doctor();
    expect(report.checks.map((c) => [c.id, c.status])).toEqual([
      ["node", "pass"],
      ["config", "pass"],
      ["secrets", "pass"],
      ["dispatcher", "pass"],
      ["dispatcher-auth", "pass"],
      ["heartbeat", "pass"],
      ["ollama", "pass"],
      ["cloud", "pass"],
      ["sqlite", "pass"],
      ["paperclip", "pass"],
    ]);
    expect(report.ok).toBe(true);
    expect(byId(report, "cloud").message).toMatch(/nothing leaves your machines/);
  });

  it("never prints a secret, in text or JSON", async () => {
    const out: string[] = [];
    const net = fakeNet({}, () => secret);
    for (const args of [[], ["--json"]]) {
      await runDoctorCommand(args, {
        cwd: dir,
        env: {},
        fetch: net.fetchFn,
        now: () => NOW,
        nodeVersion: "22.12.0",
        write: (s) => out.push(s),
      });
    }
    const text = out.join("\n");
    expect(text).not.toContain(secret);
    expect(text).not.toContain(PAPERCLIP_KEY);
  });

  it("fails with a fix when there is no config, and exits 1", async () => {
    const empty = mkdtempSync(join(tmpdir(), "ebbgate-doctor-empty-"));
    try {
      const out: string[] = [];
      const code = await runDoctorCommand([], {
        cwd: empty,
        env: {},
        fetch: fakeNet().fetchFn,
        nodeVersion: "22.12.0",
        write: (s) => out.push(s),
      });
      expect(code).toBe(1);
      expect(out.join("\n")).toMatch(/FAIL\s+Config\s+no ebbgate\.yaml/);
      expect(out.join("\n")).toContain("fix: run `ebbgate init`");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("names a missing secret variable and still checks the rest", async () => {
    writeFileSync(join(dir, ".env"), "EG_NODE_MINI_TOKEN=node-token-0123456789\n", {
      mode: 0o600,
    });
    const report = await doctor(fakeNet());
    const config = byId(report, "config");
    expect(config.status).toBe("fail");
    expect(config.message).toContain("EG_PAPERCLIP_SECRET");
    expect(config.message).toContain("PAPERCLIP_API_KEY");
    expect(config.fix).toContain(join(dir, ".env"));
    expect(byId(report, "dispatcher").status).toBe("pass"); // URL still known
    expect(byId(report, "dispatcher-auth").status).toBe("warn");
    expect(byId(report, "paperclip").status).toBe("warn");
    expect(report.ok).toBe(false);
  });

  it("fails when the secrets file is readable by others", async () => {
    chmodSync(join(dir, ".env"), 0o644);
    const s = byId(await doctor(), "secrets");
    expect(s.status).toBe("fail");
    expect(s.fix).toBe(`chmod 600 ${join(dir, ".env")}`);
  });

  it("fails when the dispatcher is down, and skips the heartbeat", async () => {
    const report = await doctor(fakeNet({ "127.0.0.1:8790/healthz": down }));
    expect(byId(report, "dispatcher").status).toBe("fail");
    expect(byId(report, "dispatcher").message).toContain("ECONNREFUSED");
    expect(byId(report, "heartbeat").status).toBe("warn");
    expect(report.ok).toBe(false);
  });

  it("fails auth when the running dispatcher has a different secret", async () => {
    const report = await doctor(fakeNet({}, () => "some-other-secret-0123456789"));
    expect(byId(report, "dispatcher-auth").status).toBe("fail");
  });

  it("warns on a stale or missing heartbeat", async () => {
    const stale = fakeNet({
      "127.0.0.1:8790/status": () =>
        Response.json({ nodes: [{ node: "mini", lastSeenAt: "2026-11-23T09:50:00Z" }] }),
    });
    const hb = byId(await doctor(stale), "heartbeat");
    expect(hb.status).toBe("warn");
    expect(hb.message).toMatch(/mini: last seen 600s ago/);
    expect(hb.fix).toContain("ebbgate agent install --node mini");

    const never = fakeNet({ "127.0.0.1:8790/status": () => Response.json({ nodes: [] }) });
    expect(byId(await doctor(never), "heartbeat").message).toMatch(/mini: never reported/);
  });

  it("warns when Ollama is unreachable or has no models", async () => {
    const off = byId(await doctor(fakeNet({ "127.0.0.1:11434/api/tags": down })), "ollama");
    expect(off.status).toBe("warn");
    const empty = byId(
      await doctor(fakeNet({ "127.0.0.1:11434/api/tags": () => Response.json({ models: [] }) })),
      "ollama",
    );
    expect(empty.fix).toContain("ollama pull");
  });

  it("follows EBBGATE_OLLAMA_URL and EBBGATE_DISPATCHER_URL", async () => {
    const net = fakeNet({
      "studio:11434/api/tags": () => Response.json({ models: [{}] }),
      "disp:9000/healthz": () => Response.json({ ok: true }),
    });
    const report = await doctor(net, {
      EBBGATE_OLLAMA_URL: "http://studio:11434",
      EBBGATE_DISPATCHER_URL: "http://disp:9000/",
    });
    expect(byId(report, "ollama").status).toBe("pass");
    expect(net.calls).toContain("disp:9000/healthz");
  });

  it("warns about a plain-http cloud runner on a public host", async () => {
    const yaml = join(dir, "ebbgate.yaml");
    const text = readFileSync(yaml, "utf8").replace(
      /\n# No cloud runner[\s\S]*?# {3}runner: \S+\n/,
      "\ncloud:\n  runner: http://cloud.example.com/run\n",
    );
    writeFileSync(yaml, text);
    const c = byId(await doctor(), "cloud");
    expect(c.status).toBe("warn");
    expect(c.message).toMatch(/plain http/);
  });

  it("reports config errors by field without quoting values", async () => {
    writeFileSync(
      join(dir, "ebbgate.yaml"),
      "server: { port: 8790, publicUrl: http://127.0.0.1:8790 }\nnodes: {}\n",
    );
    const c = byId(await doctor(), "config");
    expect(c.status).toBe("fail");
    expect(c.message).toMatch(/nodes: configure at least one node/);
  });

  it("checks that the SQLite path is writable and really a database", async () => {
    mkdirSync(join(dir, "data"));
    writeFileSync(join(dir, "data", "ebbgate.db"), "not a database at all");
    const bad = byId(await doctor(), "sqlite");
    expect(bad.status).toBe("fail");
    expect(bad.message).toMatch(/not a SQLite database/);

    const ro = join(dir, "ro");
    mkdirSync(ro, { mode: 0o500 });
    const report = await doctor(undefined, { EBBGATE_DB: join(ro, "q.db") });
    // root can write anywhere; only assert when permissions apply
    if (process.getuid?.() !== 0) expect(byId(report, "sqlite").status).toBe("fail");
  });

  it("fails on an old Node version", () => {
    expect(checkNode("20.11.1").status).toBe("fail");
    expect(checkNode("v22.0.0").status).toBe("pass");
  });

  it("prints one PASS/WARN/FAIL line per check, and JSON with --json", async () => {
    const report = await doctor(fakeNet({ "127.0.0.1:11434/api/tags": down }));
    const text = formatDoctorReport(report);
    const statusLines = text.split("\n").filter((l) => /^(PASS|WARN|FAIL) /.test(l));
    expect(statusLines).toHaveLength(report.checks.length);
    expect(text).toMatch(/All required checks passed, 1 warning/);

    const out: string[] = [];
    const code = await runDoctorCommand(["--json"], {
      cwd: dir,
      env: {},
      fetch: fakeNet({}, () => secret).fetchFn,
      now: () => NOW,
      nodeVersion: "22.12.0",
      write: (s) => out.push(s),
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(out[0] ?? "") as DoctorReport;
    expect(parsed.ok).toBe(true);
    expect(parsed.checks).toHaveLength(10);
  });
});
