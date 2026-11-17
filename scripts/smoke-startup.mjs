#!/usr/bin/env node
// Post-build smoke test: start the real dispatcher binary with a malformed,
// secret-bearing config and check that stderr reports the problem without
// leaking the secret. Run after `pnpm build` (CI does).
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SECRET = "sk-live-SMOKE-SECRET-9f8e7d6c5b4a";
const dir = mkdtempSync(join(tmpdir(), "ebbgate-smoke-"));
try {
  const config = join(dir, "ebbgate.yaml");
  writeFileSync(config, `server:\n  port: 18799\npaperclip:\n  apiKey: "${SECRET}\n  broken: [\n`);
  const run = spawnSync(process.execPath, ["packages/dispatcher/dist/index.js"], {
    env: { PATH: process.env.PATH, EBBGATE_CONFIG: config, EBBGATE_DB: join(dir, "db", "e.db") },
    encoding: "utf8",
    timeout: 20_000,
  });
  const out = `${run.stdout}\n${run.stderr}`;
  const fail = (msg) => {
    console.error(
      `smoke-startup: FAIL: ${msg}\n--- output ---\n${out.replaceAll(SECRET, "<SECRET>")}`,
    );
    process.exit(1);
  };
  if (run.status !== 1) fail(`expected exit code 1, got ${run.status}`);
  if (out.includes(SECRET) || out.includes("SMOKE-SECRET")) fail("stderr leaked the secret");
  if (!/YAML parse error \(\w+\)/.test(run.stderr)) fail("stderr does not describe the YAML error");
  if (/\n\s+at /.test(run.stderr)) fail("stderr contains a stack trace");
  console.log(`smoke-startup: ok (${run.stderr.trim()})`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
