import pino from "pino";

export function createLogger(name: string) {
  return pino({
    name,
    level: process.env.LOG_LEVEL ?? "info",
    base: { service: name },
    redact: ["req.headers.authorization", "req.headers.cookie", "*.password", "*.secret"],
  });
}

export type Logger = ReturnType<typeof createLogger>;
