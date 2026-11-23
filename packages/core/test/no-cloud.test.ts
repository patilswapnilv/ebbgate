import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";

const base = (cloud: string, defaultRule: string) => `
server: { port: 8790, publicUrl: "http://127.0.0.1:8790" }
nodes:
  mini: { runner: "http://127.0.0.1:8787", token: "node-token-0123456789" }
${cloud}
paperclip:
  apiUrl: "http://127.0.0.1:3100"
  apiKey: "k"
  sharedSecret: "shared-secret-0123456789"
policies:
  - match: { tier: private }
    available: local
    busy: local-low
    offline: defer
  - default: ${defaultRule}
`;

describe("config without a cloud runner", () => {
  it("loads when every rule stays local or defers", () => {
    const cfg = loadConfig(base("", "{ available: local, busy: local-low, offline: defer }"));
    expect(cfg.cloud).toBeUndefined();
  });

  it("rejects a cloud action when no cloud runner is configured", () => {
    let err: unknown;
    try {
      loadConfig(base("", "{ available: cloud, busy: cloud, offline: defer }"));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    const paths = (err as ConfigError).issues.map((i) => i.path);
    expect(paths).toEqual(["policies.1.default.available", "policies.1.default.busy"]);
    expect((err as ConfigError).message).toMatch(/no cloud runner is configured/);
  });

  it("still accepts cloud actions once a cloud runner is set", () => {
    const cfg = loadConfig(
      base(
        'cloud: { runner: "https://cloud.example/run" }',
        "{ available: cloud, busy: cloud, offline: cloud }",
      ),
    );
    expect(cfg.cloud?.runner).toBe("https://cloud.example/run");
  });
});
