/**
 * Privacy guarantee, fuzzing `POST /run` end to end with fast-check: random
 * payloads, agents, labels, presence and clock moves. The oracle is the network
 * tap: the cloud runner may only ever see explicitly cloud-eligible agents.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  AGENTS,
  assertNoPrivateLeak,
  harness,
  postPresence,
  postRun,
  UNKNOWN_AGENTS,
} from "./harness.js";

// Hundreds of property runs, each opening a fresh SQLite harness: slow on shared CI runners.
const PROPERTY_TIMEOUT_MS = 60_000;

const agentArb = fc.oneof(
  { weight: 4, arbitrary: fc.constantFrom(...Object.keys(AGENTS)) },
  { weight: 2, arbitrary: fc.constantFrom(...UNKNOWN_AGENTS) },
  { weight: 1, arbitrary: fc.string({ minLength: 1, maxLength: 24 }) },
  { weight: 1, arbitrary: fc.anything() },
);

const labelsArb = fc.oneof(
  fc.array(fc.oneof(fc.constantFrom("local-files", "public", "cloud", "private"), fc.string()), {
    maxLength: 6,
  }),
  fc.constant(undefined),
  fc.constant(null),
  fc.anything(),
);

const payloadArb = fc.record(
  {
    runId: fc.oneof(fc.uuid(), fc.string({ maxLength: 12 }), fc.anything()),
    agentId: agentArb,
    tier: fc.constantFrom("public", "internal", "private", undefined),
    context: fc.oneof(
      fc.record(
        {
          taskId: fc.oneof(fc.uuid(), fc.constant(undefined)),
          companyId: fc.oneof(fc.constant("company-test"), fc.anything()),
          labels: labelsArb,
          tier: fc.constantFrom("public", "internal"),
        },
        { requiredKeys: [] },
      ),
      fc.anything(),
    ),
  },
  { requiredKeys: ["runId", "agentId"] },
);

const stepArb = fc.oneof(
  { weight: 5, arbitrary: payloadArb.map((p) => ({ kind: "run" as const, p })) },
  {
    weight: 2,
    arbitrary: fc
      .record({
        node: fc.constantFrom("mini" as const, "mbp" as const),
        mode: fc.constantFrom("auto", "busy", "available"),
        onBattery: fc.boolean(),
      })
      .map((r) => ({ kind: "presence" as const, ...r })),
  },
  {
    weight: 2,
    arbitrary: fc
      .integer({ min: -120_000, max: 120_000 })
      .map((ms) => ({ kind: "clock" as const, ms })),
  },
  { weight: 1, arbitrary: fc.constant({ kind: "restart" as const }) },
);

describe("privacy guarantee: fuzzing /run", () => {
  it(
    "property: no sequence of requests, presence changes, clock moves and restarts leaks private work",
    async () => {
      let cloudSeen = 0;
      await fc.assert(
        fc.asyncProperty(fc.array(stepArb, { minLength: 1, maxLength: 25 }), async (steps) => {
          const h = harness();
          try {
            for (const step of steps) {
              if (step.kind === "run") {
                const res = await postRun(h, step.p);
                expect([200, 202, 400, 500, 502]).toContain(res.status);
              } else if (step.kind === "presence") {
                await postPresence(h, step.node, { mode: step.mode, onBattery: step.onBattery });
              } else if (step.kind === "clock") {
                h.clock.now = new Date(h.clock.now.getTime() + step.ms);
                await h.handle.tick();
              } else {
                await h.restart().presence.reconcileAfterRestart();
              }
            }
            assertNoPrivateLeak(h);
            cloudSeen += h.net.toCloud().length;
          } finally {
            h.close();
          }
        }),
        { numRuns: 150 },
      );
      expect(cloudSeen).toBeGreaterThan(0); // the cloud path was reachable during fuzzing
    },
    PROPERTY_TIMEOUT_MS,
  );
});
