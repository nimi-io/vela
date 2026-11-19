import { serve } from "@hono/node-server";
import { env, createLogger, closeQueues } from "@vela/core";
import { closeDb } from "@vela/db";
import { createApp } from "./app.js";

const log = createLogger("stream");

const e = env();
const server = serve({ fetch: createApp().fetch, port: e.STREAM_PORT, hostname: "0.0.0.0" }, (info) =>
  log.info(`stream service listening on :${info.port}`),
);

const shutdown = async () => {
  server.close();
  await closeQueues();
  await closeDb();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
