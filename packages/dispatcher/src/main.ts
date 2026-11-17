import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * True when `moduleUrl` is the program Node was asked to run, comparing resolved
 * file URLs (symlinks included), so importing the module never starts the server.
 */
export function isEntrypoint(
  moduleUrl: string,
  argv1: string | undefined = process.argv[1],
): boolean {
  if (!argv1) return false;
  try {
    return (
      pathToFileURL(realpathSync(argv1)).href ===
      pathToFileURL(realpathSync(new URL(moduleUrl))).href
    );
  } catch {
    return false;
  }
}
