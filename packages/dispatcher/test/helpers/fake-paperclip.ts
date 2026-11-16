import { parseRun } from "../../src/paperclip/parse.js";
import type { PaperclipClient, TaskContextInput } from "../../src/paperclip/types.js";

export interface FakePaperclip extends PaperclipClient {
  wakes: Array<{ agentId: string; issueId?: string; reason: string; idempotencyKey?: string }>;
  comments: Array<{ issueId: string; body: string }>;
  labels: Array<{ issueId: string; label: string }>;
  /** Number of upcoming wakeAgent calls that should fail. */
  failNextWakes: number;
  /** When set, wakeAgent waits for this promise (to hold a drain open). */
  wakeGate: Promise<void> | null;
  /** Highest number of wakeAgent calls in flight at the same time. */
  maxInFlightWakes: number;
}

export function createFakePaperclip(): FakePaperclip {
  let inFlight = 0;
  const fake: FakePaperclip = {
    wakes: [],
    comments: [],
    labels: [],
    failNextWakes: 0,
    wakeGate: null,
    maxInFlightWakes: 0,
    parseRun(body: unknown, headers: Headers): TaskContextInput {
      return parseRun(body, headers);
    },
    async wakeAgent(args): Promise<void> {
      inFlight += 1;
      fake.maxInFlightWakes = Math.max(fake.maxInFlightWakes, inFlight);
      try {
        if (fake.wakeGate) await fake.wakeGate;
      } finally {
        inFlight -= 1;
      }
      if (fake.failNextWakes > 0) {
        fake.failNextWakes -= 1;
        throw new Error("paperclip unavailable");
      }
      fake.wakes.push({
        agentId: args.agentId,
        ...(args.issueId ? { issueId: args.issueId } : {}),
        reason: args.reason,
        ...(args.idempotencyKey ? { idempotencyKey: args.idempotencyKey } : {}),
      });
    },
    async commentOnIssue(issueId, body): Promise<void> {
      fake.comments.push({ issueId, body });
    },
    async addLabel(issueId, label): Promise<void> {
      fake.labels.push({ issueId, label });
    },
  };
  return fake;
}
