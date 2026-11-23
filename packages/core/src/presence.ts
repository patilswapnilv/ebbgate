import { z } from "zod";
import type { PresenceReport } from "./types.js";

/** Limits a presence report must respect. Agents normalize to these before sending. */
export const PRESENCE_LIMITS = {
  maxModels: 512,
  maxModelNameLength: 256,
  maxNodeIdLength: 64,
  maxAgentVersionLength: 64,
} as const;

/** Runtime schema for a presence heartbeat (see `PresenceReport`). */
export const presenceReportSchema = z
  .object({
    node: z.string().min(1).max(PRESENCE_LIMITS.maxNodeIdLength),
    mode: z.enum(["auto", "busy", "available"]),
    freeRamGb: z.number().finite().min(0),
    onBattery: z.boolean(),
    userIdleSeconds: z.number().finite().min(0),
    modelsLoaded: z
      .array(z.string().max(PRESENCE_LIMITS.maxModelNameLength))
      .max(PRESENCE_LIMITS.maxModels),
    modelsInstalled: z
      .array(z.string().max(PRESENCE_LIMITS.maxModelNameLength))
      .max(PRESENCE_LIMITS.maxModels),
    agentVersion: z.string().min(1).max(PRESENCE_LIMITS.maxAgentVersionLength),
    sentAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export type PresenceReportResult =
  | { ok: true; report: PresenceReport }
  | { ok: false; issues: Array<{ path: string; message: string }> };

/** Validate an untrusted presence payload. Pure: no I/O. */
export function parsePresenceReport(input: unknown): PresenceReportResult {
  const result = presenceReportSchema.safeParse(input);
  if (!result.success) {
    return {
      ok: false,
      issues: result.error.issues.map((i) => ({
        path: i.path.map(String).join("."),
        message: i.message,
      })),
    };
  }
  return { ok: true, report: result.data };
}
