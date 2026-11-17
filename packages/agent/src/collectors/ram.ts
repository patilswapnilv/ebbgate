import { execFile } from "node:child_process";
import { freemem, totalmem } from "node:os";
import { promisify } from "node:util";
import { COLLECTOR_EXEC_OPTIONS } from "./limits.js";

const execFileAsync = promisify(execFile);

/**
 * Free RAM in GiB. Prefer `vm_stat` pages free+inactive+purgeable on macOS;
 * fall back to `os.freemem()`.
 */
export async function freeRamGb(exec: typeof execFileAsync = execFileAsync): Promise<number> {
  try {
    const { stdout } = await exec("vm_stat", [], { encoding: "utf8", ...COLLECTOR_EXEC_OPTIONS });
    const pageSize = parsePageSize(stdout) ?? 16384;
    const free = pages(stdout, "Pages free");
    const inactive = pages(stdout, "Pages inactive");
    const purgeable = pages(stdout, "Pages purgeable");
    if (free !== null) {
      const bytes = (free + (inactive ?? 0) + (purgeable ?? 0)) * pageSize;
      return round1(bytes / 1024 ** 3);
    }
  } catch {
    // fall through
  }
  return round1(freemem() / 1024 ** 3);
}

export function totalRamGb(): number {
  return round1(totalmem() / 1024 ** 3);
}

function parsePageSize(text: string): number | null {
  const m = /page size of (\d+) bytes/i.exec(text);
  return m ? Number(m[1]) : null;
}

function pages(text: string, label: string): number | null {
  const re = new RegExp(`${label}:\\s*([\\d,]+)\\.?`, "i");
  const m = re.exec(text);
  const raw = m?.[1];
  return raw ? Number(raw.replace(/,/g, "")) : null;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export { execFileAsync };
