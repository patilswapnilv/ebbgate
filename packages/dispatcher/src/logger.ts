import pino, { type Logger } from "pino";

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

export function createLogger(level = "info"): Logger {
  return pino({
    level,
    redact: {
      paths: REDACT_PATHS,
      censor: "[Redacted]",
    },
  });
}

export type { Logger };
