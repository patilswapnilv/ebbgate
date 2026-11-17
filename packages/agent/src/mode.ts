import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { PresenceMode } from "@ebbgate/core";
import { MODE_FILE } from "./paths.js";

const MODES = new Set<PresenceMode>(["auto", "busy", "available"]);

export function readMode(path = MODE_FILE): PresenceMode {
  try {
    const raw = readFileSync(path, "utf8").trim();
    if (MODES.has(raw as PresenceMode)) return raw as PresenceMode;
  } catch {
    // missing file → default auto
  }
  return "auto";
}

/** Map CLI `busy on|off|auto` to PresenceMode. */
export function busyArgToMode(arg: string): PresenceMode {
  if (arg === "on") return "busy";
  if (arg === "off") return "available";
  if (arg === "auto") return "auto";
  throw new Error(`usage: ebbgate busy on|off|auto (got ${arg})`);
}

export function writeMode(mode: PresenceMode, path = MODE_FILE): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${mode}\n`, { mode: 0o600 });
}
