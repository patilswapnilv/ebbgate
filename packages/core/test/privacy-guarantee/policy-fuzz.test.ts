/**
 * Privacy guarantee, the pure engine, fuzzed with fast-check.
 *
 * Two independent layers are checked separately:
 *  1. Config validation is sound: for every accepted config, no private task
 *     ever needs the runtime guard (no "blocked:" reason ever appears).
 *  2. The runtime guard alone is enough: even with configs that skip
 *     validation, and tiers that are not tiers at all, decide() never returns
 *     cloud for anything that is not explicitly internal or public.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { decideAdmission } from "../../src/admission.js";
import { type EbbgateConfig, type PolicyRule, parseConfig } from "../../src/config.js";
import { decide, mayRunInCloud, resolveTier } from "../../src/policy.js";
import type { NodeStatus, TaskContext } from "../../src/types.js";
import { node } from "../helpers.js";

const NODE_IDS = ["n1", "n2"];
const LABELS = ["local-files", "urgent", "client-a"];
const actionArb = fc.constantFrom("local", "local-low", "cloud", "defer" as const);
const offlineArb = fc.constantFrom("cloud", "defer" as const);
const actionsArb = fc.record({ available: actionArb, busy: actionArb, offline: offlineArb });

const matchRuleArb = fc
  .record({
    tier: fc.option(fc.constantFrom("private", "internal", "public"), { nil: undefined }),
    label: fc.option(fc.constantFrom(...LABELS), { nil: undefined }),
    notify: fc.boolean(),
  })
  .filter((m) => m.tier !== undefined || m.label !== undefined)
  .chain((m) =>
    actionsArb.map((a) => ({
      match: {
        ...(m.tier ? { tier: m.tier } : {}),
        ...(m.label ? { label: m.label } : {}),
      },
      ...a,
      notify: m.notify,
    })),
  );

const policiesArb = fc
  .tuple(fc.array(matchRuleArb, { maxLength: 5 }), actionsArb)
  .map(([rules, d]) => [...rules, { default: { ...d, notify: false } }] as PolicyRule[]);

const statesArb = fc.array(fc.constantFrom("available", "busy", "offline" as const), {
  minLength: NODE_IDS.length,
  maxLength: NODE_IDS.length,
});

function configFor(policies: PolicyRule[]): EbbgateConfig | null {
  try {
    return parseConfig({
      server: { publicUrl: "http://cloud:8790" },
      nodes: Object.fromEntries(
        NODE_IDS.map((id) => [
          id,
          { runner: `http://${id}:8787`, token: `token-${id}-0123456789` },
        ]),
      ),
      cloud: { runner: "http://openclaw:18789/paperclip" },
      paperclip: { apiUrl: "http://p:3100", apiKey: "k", sharedSecret: "s".repeat(32) },
      agents: {
        a_priv: { tier: "private" },
        a_int: { tier: "internal" },
        a_pub: { tier: "public" },
      },
      policies,
    });
  } catch {
    return null;
  }
}

const agentArb = fc.oneof(
  fc.constantFrom("a_priv", "a_int", "a_pub", "unknown", "constructor", "__proto__", ""),
  fc.string({ maxLength: 10 }),
);
const labelsArb = fc.array(fc.oneof(fc.constantFrom(...LABELS), fc.string({ maxLength: 6 })), {
  maxLength: 4,
});

function nodesFrom(states: readonly string[]): NodeStatus[] {
  return NODE_IDS.map((id, i) => node(id, states[i] as "available" | "busy" | "offline"));
}

describe("privacy guarantee: policy engine (property-based)", () => {
  it("validated configs never route a private or unknown agent to the cloud, and never need the guard", () => {
    let accepted = 0;
    fc.assert(
      fc.property(
        policiesArb,
        agentArb,
        labelsArb,
        statesArb,
        (policies, agentId, labels, states) => {
          const config = configFor(policies);
          if (!config) return;
          accepted++;
          const tier = resolveTier(agentId, config);
          const task: TaskContext = { runId: "r", agentId, companyId: "c", tier, labels };
          const d = decide(task, nodesFrom(states), config);
          if (agentId !== "a_int" && agentId !== "a_pub") {
            expect(tier).toBe("private");
            expect(d.action).not.toBe("cloud");
            // Layer 1 alone holds: validation left no path that the guard had to block.
            expect(d.reason).not.toContain("blocked:");
          }
        },
      ),
      { numRuns: 5000 },
    );
    expect(accepted).toBeGreaterThan(500);
  });

  it("FIXED: the runtime guard alone holds for unvalidated configs and non-tier values", () => {
    const tierArb = fc.oneof(
      fc.constantFrom("private", undefined, null, "", "Private", "PUBLIC", "cloud", 0, {}),
      fc.anything(),
    );
    fc.assert(
      fc.property(policiesArb, tierArb, labelsArb, statesArb, (policies, tier, labels, states) => {
        // Bypass parseConfig entirely: the leakiest rules are allowed through.
        const config = {
          nodes: Object.fromEntries(
            NODE_IDS.map((id) => [
              id,
              { runner: `http://${id}`, token: "t".repeat(16), prefer: false },
            ]),
          ),
          policies,
        } as unknown as Pick<EbbgateConfig, "nodes" | "policies">;
        const task = {
          runId: "r",
          agentId: "x",
          companyId: "c",
          tier,
          labels,
        } as unknown as TaskContext;
        let action: string;
        try {
          action = decide(task, nodesFrom(states), config).action;
        } catch {
          // A tier that cannot even be stringified makes decide() throw: no decision,
          // so nothing is dispatched (the dispatcher answers 500). That is fail-closed.
          return;
        }
        if (!mayRunInCloud(tier)) expect(action).not.toBe("cloud");
      }),
      { numRuns: 5000 },
    );
  });

  it("nodes the config does not know are ignored, even with Object.prototype names", () => {
    fc.assert(
      fc.property(policiesArb, (policies) => {
        const config = configFor(policies);
        if (!config) return;
        const ghosts = ["constructor", "__proto__", "toString", "ghost"].map((id) =>
          node(id, "available"),
        );
        const d = decide(
          { runId: "r", agentId: "a_priv", companyId: "c", tier: "private", labels: [] },
          ghosts,
          config,
        );
        expect(d.action).toBe("defer");
      }),
      { numRuns: 500 },
    );
  });

  it("admission: nothing private is ever admitted remotely, nothing is admitted on an offline node", () => {
    fc.assert(
      fc.property(
        policiesArb,
        agentArb,
        fc.boolean(),
        fc.option(labelsArb, { nil: undefined }),
        statesArb,
        fc.oneof(
          fc.constant({ kind: "remote" as const }),
          fc
            .constantFrom(...NODE_IDS, "constructor")
            .map((n) => ({ kind: "node" as const, node: n })),
        ),
        (policies, agentId, issuePrivate, labels, states, target) => {
          const config = configFor(policies);
          if (!config) return;
          const nodes = nodesFrom(states);
          const r = decideAdmission(
            {
              ...(agentId ? { agentId } : {}),
              issuePrivate,
              ...(labels ? { labels } : {}),
              target,
            },
            nodes,
            config,
          );
          if (!r.admit) return;
          if (target.kind === "remote") {
            expect(issuePrivate).toBe(false);
            expect(["a_int", "a_pub"]).toContain(agentId);
            expect(mayRunInCloud(r.tier)).toBe(true);
          } else {
            const st = nodes.find((n) => n.node === target.node)?.state;
            expect(st === "available" || st === "busy").toBe(true);
          }
        },
      ),
      { numRuns: 5000 },
    );
  });
});
