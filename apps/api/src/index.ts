import { serve } from "@hono/node-server";
import { env, createLogger, closeQueues } from "@vela/core";
import { closeDb } from "@vela/db";
import { runMigrations } from "@vela/db/migrate";
import { createApp } from "./app.js";

const log = createLogger("api");

async function main() {
  const e = env();
  if (process.env.RUN_MIGRATIONS !== "false") {
    await runMigrations(e.DATABASE_URL);
    log.info("database migrations applied");
  }
  const app = createApp();
  const server = serve({ fetch: app.fetch, port: e.API_PORT, hostname: "0.0.0.0" }, (info) => {
    log.info(`API listening on :${info.port}`);
  });

  const shutdown = async () => {
    log.info("shutting down");
    server.close();
    await closeQueues();
    await closeDb();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  log.error(err);
  process.exit(1);
});
