import pino from "pino";

/**
 * Structured server logger. Never pass secrets, passwords, session tokens,
 * robot device secrets, or full request bodies containing evidence bytes —
 * redact paths cover the common accidental-inclusion cases, but callers are
 * still responsible for not logging sensitive values directly.
 */
export const logger = pino({
  level: process.env.NODE_ENV === "production" ? "info" : "debug",
  redact: {
    paths: [
      "password",
      "*.password",
      "secret",
      "*.secret",
      "authorization",
      "*.authorization",
      "req.headers.authorization",
      "deviceSecret",
      "*.deviceSecret",
    ],
    censor: "[REDACTED]",
  },
  formatters: {
    level: (label) => ({ level: label }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export function childLogger(bindings: Record<string, unknown>) {
  return logger.child(bindings);
}
