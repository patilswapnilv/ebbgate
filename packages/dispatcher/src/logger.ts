import pino, { type DestinationStream, type Logger } from "pino";

/** Paths that must never appear in log output (tokens, keys, secrets). */
const REDACT_PATHS = [
  "req.headers.authorization",
  "headers.authorization",
  "Authorization",
  "authorization",
  "token",
  "apiKey",
  "sharedSecret",
  "botToken",
  "paperclip.apiKey",
  "paperclip.sharedSecret",
  "notify.telegram.botToken",
  "*.token",
  "*.apiKey",
  "*.sharedSecret",
  "*.botToken",
  "*.telegram.botToken",
];

/**
 * The dispatcher's logger. `destination` is for tests that need to capture
 * output; production writes to stdout.
 */
export function createLogger(level = "info", destination?: DestinationStream): Logger {
  const options = { level, redact: { paths: REDACT_PATHS, censor: "[Redacted]" } };
  return destination ? pino(options, destination) : pino(options);
}

export type { Logger };
