import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { busyArgToMode, readMode, writeMode } from "../src/mode.js";

describe("mode file", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it("maps busy CLI args", () => {
    expect(busyArgToMode("on")).toBe("busy");
    expect(busyArgToMode("off")).toBe("available");
    expect(busyArgToMode("auto")).toBe("auto");
    expect(() => busyArgToMode("nope")).toThrow();
  });

  it("defaults to auto when missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "ebbgate-mode-"));
    dirs.push(dir);
    expect(readMode(join(dir, "mode"))).toBe("auto");
  });

  it("round-trips write/read", () => {
    const dir = mkdtempSync(join(tmpdir(), "ebbgate-mode-"));
    dirs.push(dir);
    const path = join(dir, "mode");
    writeMode("busy", path);
    expect(readMode(path)).toBe("busy");
    expect(readFileSync(path, "utf8").trim()).toBe("busy");
  });
});
