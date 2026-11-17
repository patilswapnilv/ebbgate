import { z } from "zod";
import type { PresenceReport } from "./types.js";

/** Runtime schema for a presence heartbeat (see `PresenceReport`). */
export const presenceReportSchema = z
  .object({
    node: z.string().min(1).max(64),
    mode: z.enum(["auto", "busy", "available"]),
    freeRamGb: z.number().finite().min(0),
    onBattery: z.boolean(),
    userIdleSeconds: z.number().finite().min(0),
    modelsLoaded: z.array(z.string().max(256)).max(512),
    modelsInstalled: z.array(z.string().max(256)).max(512),
    agentVersion: z.string().min(1).max(64),
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
