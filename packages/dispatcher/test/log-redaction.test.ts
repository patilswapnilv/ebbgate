import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger } from "../src/logger.js";

describe("log redaction", () => {
  it("redacts tokens and secrets from pino output", async () => {
    const chunks: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(String(chunk));
        cb();
      },
    });

    // Exercise the dispatcher's own logger, so removing its redaction fails this test.
    const logger = createLogger("info", stream);

    const secret = "shared-secret-0123456789abcdef";
    const apiKey = "pc-super-secret-api-key-zzzz";
    const nodeToken = "mini-token-0123456789abcdef";

    logger.info(
      {
        authorization: `Bearer ${secret}`,
        headers: { authorization: `Bearer ${secret}` },
        paperclip: { apiKey, sharedSecret: secret },
        node: { token: nodeToken },
        notify: { telegram: { botToken: "123:TELEGRAM_BOT_TOKEN_SECRET" } },
      },
      "auth dump",
    );

    // Allow async flush.
    await new Promise((r) => setTimeout(r, 20));
    const out = chunks.join("");

    expect(out).not.toContain(secret);
    expect(out).not.toContain(apiKey);
    expect(out).not.toContain(nodeToken);
    expect(out).not.toContain("TELEGRAM_BOT_TOKEN_SECRET");
    expect(out).toContain("[Redacted]");
  });

  it("createLogger constructs without throwing", () => {
    const logger = createLogger("silent");
    expect(logger).toBeTruthy();
  });
});
