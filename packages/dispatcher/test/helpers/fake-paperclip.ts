import { parseRun } from "../../src/paperclip/parse.js";
import type { PaperclipClient, TaskContextInput } from "../../src/paperclip/types.js";

export interface FakePaperclip extends PaperclipClient {
  wakes: Array<{ agentId: string; issueId?: string; reason: string }>;
  comments: Array<{ issueId: string; body: string }>;
  labels: Array<{ issueId: string; label: string }>;
}

export function createFakePaperclip(): FakePaperclip {
  const wakes: FakePaperclip["wakes"] = [];
  const comments: FakePaperclip["comments"] = [];
  const labels: FakePaperclip["labels"] = [];

  return {
    wakes,
    comments,
    labels,
    parseRun(body: unknown, headers: Headers): TaskContextInput {
      return parseRun(body, headers);
    },
    async wakeAgent(args): Promise<void> {
      wakes.push({
        agentId: args.agentId,
        ...(args.issueId ? { issueId: args.issueId } : {}),
        reason: args.reason,
      });
    },
    async commentOnIssue(issueId, body): Promise<void> {
      comments.push({ issueId, body });
    },
    async addLabel(issueId, label): Promise<void> {
      labels.push({ issueId, label });
    },
  };
}
