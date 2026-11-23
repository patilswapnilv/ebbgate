import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb } from "../src/db/index.js";
import { parseAdmitBody } from "../src/routes/admit.js";
import { SECRET, testConfig } from "./helpers/config.js";
import { createFakePaperclip } from "./helpers/fake-paperclip.js";

describe("POST /admit", () => {
  function build() {
    const db = openDb(":memory:");
    const config = testConfig({
      localRunner: "http://127.0.0.1:1/run",
      cloudRunner: "http://127.0.0.1:2/run",
    });
    return { db, ...createApp({ config, db, paperclip: createFakePaperclip(), demo: false }) };
  }
  const post = (app: ReturnType<typeof build>["app"], body: unknown, auth = `Bearer ${SECRET}`) =>
    app.request("/admit", {
      method: "POST",
      headers: { authorization: auth, "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  it("requires the shared secret", async () => {
    const { app, db } = build();
    expect((await post(app, { target: "remote" }, "Bearer nope")).status).toBe(401);
    db.close();
  });

  it("rejects malformed bodies with 400", async () => {
    const { app, db } = build();
    for (const body of [
      "{",
      [],
      { target: "cloud" },
      { target: "node" },
      { target: "remote", node: "mini" },
      { target: "remote", extra: 1 },
      { target: "remote", agentId: "bad id with spaces" },
      { target: "remote", labels: "x" },
    ]) {
      expect((await post(app, body)).status).toBe(400);
    }
    db.close();
  });

  it("answers from live presence and records nothing", async () => {
    const { app, db } = build();
    const res = await post(app, { target: "remote", agentId: "agent_inbox" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ admit: false, tier: "private" });
    const r2 = await post(app, { target: "remote", agentId: "agent_ops", labels: [] });
    expect(await r2.json()).toMatchObject({ admit: true, tier: "internal" });
    expect((db.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n).toBe(0);
    db.close();
  });

  it("parseAdmitBody keeps only known fields", () => {
    expect(parseAdmitBody({ target: "node", node: "mini", issuePrivate: false })).toEqual({
      target: { kind: "node", node: "mini" },
    });
  });
});
