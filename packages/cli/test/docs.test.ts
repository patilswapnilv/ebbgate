import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (p: string) =>
  readFileSync(fileURLToPath(new URL(`../../../${p}`, import.meta.url)), "utf8");

describe("top-level README", () => {
  const readme = read("README.md");

  it("uses commands that work from a clean checkout", () => {
    expect(readme).not.toContain("--filter @ebbgate/cli exec");
    expect(readme).toContain("pnpm ebbgate agent install");
    expect(readme).toContain("pnpm ebbgate init");
  });

  it("builds the quickstart around init and doctor", () => {
    expect(readme).toContain("npx ebbgate init && npx ebbgate doctor");
    expect(readme).toContain("ebbgate agent install");
    expect(readme).toContain("ebbgate agent uninstall");
    expect(readme).toMatch(/mode 600/);
  });

  it("gives nodes only their own token through an env file", () => {
    expect(readme).toContain("--env-file ~/.ebbgate/.env");
    expect(readme).toContain("chmod 600 ~/.ebbgate/.env");
  });
});
