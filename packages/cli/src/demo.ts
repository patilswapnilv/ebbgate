// The side-effect-free entry: "@ebbgate/dispatcher" itself starts a server when bundled
// into an entrypoint, so the CLI must only import the demo module.
import { runDemo } from "@ebbgate/dispatcher/demo";

/** Default pause between demo steps: readable live, ~6s in total. */
export const DEMO_STEP_DELAY_MS = 900;

/**
 * `ebbgate demo [--fast]`: runs the real dispatcher in-process against a fake
 * Paperclip and fake runners. Needs no Paperclip, Docker, API keys or config.
 */
export async function runDemoCommand(
  args: string[],
  write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
): Promise<void> {
  const fast = args.includes("--fast") || process.env.CI === "true";
  const result = await runDemo({ write, stepDelayMs: fast ? 0 : DEMO_STEP_DELAY_MS });
  if (result.privateToCloud !== 0 || result.pendingAtEnd !== 0) {
    throw new Error("ebbgate demo: unexpected routing result");
  }
}
