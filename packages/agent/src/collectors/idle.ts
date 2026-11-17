import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { COLLECTOR_EXEC_OPTIONS } from "./limits.js";

const execFileAsync = promisify(execFile);

/** User idle time in seconds from HIDIdleTime (nanoseconds in ioreg). */
export async function userIdleSeconds(exec: typeof execFileAsync = execFileAsync): Promise<number> {
  try {
    const { stdout } = await exec("ioreg", ["-c", "IOHIDSystem"], {
      encoding: "utf8",
      ...COLLECTOR_EXEC_OPTIONS,
    });
    return parseHidIdleSeconds(stdout);
  } catch {
    return 0;
  }
}

/** Exported for tests. */
export function parseHidIdleSeconds(ioregOutput: string): number {
  // "HIDIdleTime" = 12345678900  or  "HIDIdleTime" = <bigint>
  const m =
    /"HIDIdleTime"\s*=\s*(\d+)/.exec(ioregOutput) ?? /HIDIdleTime.*?=\s*(\d+)/.exec(ioregOutput);
  if (!m) return 0;
  const ns = Number(m[1]);
  if (!Number.isFinite(ns) || ns < 0) return 0;
  return Math.floor(ns / 1e9);
}
