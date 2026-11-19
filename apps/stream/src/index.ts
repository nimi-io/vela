import { serve } from "@hono/node-server";
import { env, createLogger, closeQueues, onInvalidation } from "@vela/core";
import { closeDb } from "@vela/db";
import { createApp } from "./app.js";
import { invalidate } from "./lib/playback.js";

const log = createLogger("stream");

const e = env();
const stopInvalidations = onInvalidation(invalidate);
const server = serve({ fetch: createApp().fetch, port: e.STREAM_PORT, hostname: "0.0.0.0" }, (info) =>
  log.info(`stream service listening on :${info.port}`),
);

const shutdown = async () => {
  server.close();
  await stopInvalidations();
  await closeQueues();
  await closeDb();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
