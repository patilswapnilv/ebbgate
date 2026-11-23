/**
 * Privacy guarantee, admission (`POST /admit`, used by `ebbgate admit` as a
 * Paperclip admissionCommand): with the Mac offline, nothing private is
 * admitted anywhere, and a remote environment never admits private work.
 */
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cloudEligible,
  type Harness,
  harness,
  postAdmit,
  postPresence,
  UNKNOWN_AGENTS,
} from "./harness.js";

interface AdmitAnswer {
  admit: boolean;
  tier: string;
  reason: string;
}

describe("privacy guarantee: admission", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });
  afterEach(() => h.close());

  async function ask(body: Record<string, unknown>): Promise<AdmitAnswer> {
    const res = await postAdmit(h, body);
    expect(res.status, JSON.stringify(body)).toBe(200);
    return (await res.json()) as AdmitAnswer;
  }

  it("Mac offline: private, unknown and missing agents are refused on every target", async () => {
    for (const agentId of [
      "agent_inbox",
      "agent_finance",
      ...UNKNOWN_AGENTS.filter((a) => /^[A-Za-z0-9._:-]+$/.test(a)),
      undefined,
    ]) {
      for (const target of [
        { target: "remote" },
        { target: "node", node: "mini" },
        { target: "node", node: "mbp" },
      ]) {
        const r = await ask({ ...(agentId ? { agentId } : {}), ...target });
        expect(r.admit, `${agentId} ${JSON.stringify(target)}`).toBe(false);
        expect(r.tier).toBe("private");
      }
    }
  });

  it("Mac offline: issuePrivate makes a public agent private", async () => {
    // Labels known and empty: public work may go remote...
    expect((await ask({ agentId: "agent_research", labels: [], target: "remote" })).admit).toBe(
      true,
    );
    // ...unknown labels are stricter (a `local-files` rule might apply)...
    expect((await ask({ agentId: "agent_research", target: "remote" })).admit).toBe(false);
    // ...and the issue-level private flag always wins.
    const r = await ask({
      agentId: "agent_research",
      labels: [],
      issuePrivate: true,
      target: "remote",
    });
    expect(r).toMatchObject({ admit: false, tier: "private" });
  });

  it("Mac online: private work is admitted on the Mac and still refused remotely", async () => {
    await postPresence(h, "mini");
    expect((await ask({ agentId: "agent_inbox", target: "node", node: "mini" })).admit).toBe(true);
    expect((await ask({ agentId: "agent_inbox", target: "remote" })).admit).toBe(false);
  });

  it("unknown node ids, including Object.prototype names, are refused", async () => {
    await postPresence(h, "mini");
    for (const node of ["evil", "constructor", "__proto__", "toString"]) {
      const r = await ask({ agentId: "agent_research", target: "node", node });
      expect(r.admit, node).toBe(false);
    }
  });

  it("malformed admission requests are 400 (the probe then refuses), never an admit", async () => {
    const bad: unknown[] = [
      null,
      [],
      { target: "cloud" },
      { target: "remote", tier: "public" },
      { target: "remote", agentId: "agent_inbox", issuePrivate: "false" },
      { target: "remote", agentId: "agent research" },
      { target: "remote", labels: "local-files" },
      { target: "remote", node: "mini" },
      { target: "node" },
    ];
    for (const body of bad) {
      const res = await postAdmit(h, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it("property: no request body ever admits a non-cloud-eligible task remotely", async () => {
    const agentArb = fc.oneof(
      fc.constantFrom(
        "agent_inbox",
        "agent_finance",
        "agent_ops",
        "agent_research",
        "constructor",
        "__proto__",
      ),
      fc.stringMatching(/^[A-Za-z0-9._:-]{1,20}$/),
    );
    const bodyArb = fc.record(
      {
        agentId: agentArb,
        issuePrivate: fc.boolean(),
        labels: fc.array(fc.constantFrom("local-files", "urgent", "public", "x"), { maxLength: 4 }),
        target: fc.constantFrom("remote", "node"),
        node: fc.constantFrom("mini", "mbp", "constructor"),
      },
      { requiredKeys: ["target"] },
    );
    const onlineArb = fc.subarray(["mini", "mbp"] as const);
    await fc.assert(
      fc.asyncProperty(bodyArb, onlineArb, async (raw, online) => {
        h.close();
        h = harness();
        for (const n of online) await postPresence(h, n);
        const body: Record<string, unknown> = { ...raw };
        if (body.target === "remote") delete body.node;
        else if (body.node === undefined) body.node = "mini";
        const res = await postAdmit(h, body);
        if (res.status !== 200) return; // refused by validation: fails closed
        const r = (await res.json()) as AdmitAnswer;
        if (r.admit && body.target === "remote") {
          expect(cloudEligible(body.agentId)).toBe(true);
          expect(body.issuePrivate).not.toBe(true);
          expect(r.tier === "internal" || r.tier === "public").toBe(true);
        }
        if (r.admit && body.target === "node") {
          expect(online).toContain(body.node);
        }
      }),
      { numRuns: 300 },
    );
  });
});
