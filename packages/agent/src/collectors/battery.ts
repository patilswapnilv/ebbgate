import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { COLLECTOR_EXEC_OPTIONS } from "./limits.js";

const execFileAsync = promisify(execFile);

/** True when drawing from battery (not AC). Desktop Macs without battery → false. */
export async function onBattery(exec: typeof execFileAsync = execFileAsync): Promise<boolean> {
  try {
    const { stdout } = await exec("pmset", ["-g", "batt"], {
      encoding: "utf8",
      ...COLLECTOR_EXEC_OPTIONS,
    });
    return parseOnBattery(stdout);
  } catch {
    return false;
  }
}

/** Exported for tests. */
export function parseOnBattery(pmsetOutput: string): boolean {
  // "Now drawing from 'Battery Power'" vs "'AC Power'"
  if (/drawing from ['"]Battery Power['"]/i.test(pmsetOutput)) return true;
  if (/drawing from ['"]AC Power['"]/i.test(pmsetOutput)) return false;
  // No battery line at all (desktop) → treat as plugged in.
  if (!/InternalBattery/i.test(pmsetOutput) && !/Battery/i.test(pmsetOutput)) return false;
  return /Battery Power/i.test(pmsetOutput) && !/AC Power/i.test(pmsetOutput);
}
