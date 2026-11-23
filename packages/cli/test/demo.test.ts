import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { runDemoCommand } from "../src/demo.js";

describe("ebbgate demo", () => {
  it("runs the full scenario with --fast and prints decision blocks", async () => {
    const lines: string[] = [];
    const started = Date.now();
    await runDemoCommand(["--fast"], (l) => lines.push(l));
    const text = lines.join("\n");
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(text).toContain("ebbgate decision");
    expect(text).toContain("DEFER (wait for local)");
    expect(text).toContain("private work reached the cloud: never");
  });

  it("is listed in help", async () => {
    const out: string[] = [];
    const orig = console.log;
    console.log = (m: string) => out.push(m);
    try {
      await main(["--help"]);
    } finally {
      console.log = orig;
    }
    expect(out.join("\n")).toContain("ebbgate demo");
  });

  it("package is publishable as `ebbgate` with a bin and files list", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as Record<string, unknown>;
    expect(pkg.name).toBe("ebbgate");
    expect(pkg.private).toBeUndefined();
    expect(pkg.version).toBe("0.1.0");
    expect(pkg.bin).toEqual({ ebbgate: "./dist/cli.js" });
    expect(pkg.files).toContain("dist");
    // Workspace packages are bundled, never runtime dependencies.
    const deps = Object.keys((pkg.dependencies as Record<string, string>) ?? {});
    expect(deps.filter((d) => d.startsWith("@ebbgate/"))).toEqual([]);
  });
});
