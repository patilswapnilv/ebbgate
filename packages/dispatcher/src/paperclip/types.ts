/**
 * Isolates all Paperclip HTTP API shapes behind this interface (BUILD_SPEC §7).
 * Implementations must not invent undocumented fields without TODO(verify-paperclip).
 */
export interface TaskContextInput {
  runId: string;
  agentId: string;
  companyId: string;
  issueId?: string;
  wakeReason?: string;
  labels: string[];
}

export interface PaperclipClient {
  parseRun(body: unknown, headers: Headers): TaskContextInput;
  wakeAgent(args: {
    agentId: string;
    issueId?: string;
    reason: string;
    /** Stable per deferral; reused on retries so Paperclip can deduplicate the wake. */
    idempotencyKey?: string;
  }): Promise<void>;
  commentOnIssue(issueId: string, body: string): Promise<void>;
  addLabel(issueId: string, label: string): Promise<void>;
}
