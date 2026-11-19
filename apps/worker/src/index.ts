import fsp from "node:fs/promises";
import { Worker, type Job, type Processor } from "bullmq";
import { env, createLogger, bullConnection, getQueue, QUEUES, closeQueues, type QueueName } from "@vela/core";
import { closeDb } from "@vela/db";
import { processAsset } from "./jobs/process-asset.js";
import { staticRenditions } from "./jobs/static-renditions.js";
import { ingestTrack, generateSubtitles, translateTrack, aiInsights } from "./jobs/tracks.js";
import { deliverWebhook } from "./jobs/webhooks.js";
import { liveSegment, liveFinalize, liveSimulcast } from "./jobs/live.js";
import { sweepUploads, usageRollup, deleteAssetFiles } from "./jobs/maintenance.js";
import { run } from "./lib/exec.js";
import { isFinalFailure } from "./lib/jobs.js";
import { removeJobWorkDir, runWithJobWorkDir } from "./lib/workdir.js";
import { getDb, assets, webhookDeliveries, eq, and } from "@vela/db";
import { emitEvent, loadAssetJson } from "@vela/core";

async function markAssetErrored(assetId: string, message: string) {
  const db = getDb();
  const res = await db
    .update(assets)
    .set({ status: "errored", progress: null, errors: { type: "processing_failed", messages: [message.slice(0, 2000)] } })
    .where(and(eq(assets.id, assetId), eq(assets.status, "preparing")))
    .returning();
  if (res[0]) {
    const json = await loadAssetJson(assetId);
    if (json) await emitEvent(res[0].environmentId, "video.asset.errored", json, { type: "asset", id: assetId });
  }
}

// A crash inside one job must not take down every other job on this worker.
process.on("uncaughtException", (err) => log.error({ err: err.message, stack: err.stack }, "uncaught exception"));
process.on("unhandledRejection", (err: any) => log.error({ err: err?.message ?? String(err) }, "unhandled rejection"));

const log = createLogger("worker");

const handlers: Record<string, (job: Job<any>) => Promise<unknown>> = {
  "asset.process": processAsset,
  "asset.static-renditions": staticRenditions,
  "asset.delete": deleteAssetFiles,
  "track.ingest": ingestTrack,
  "track.generate-subtitles": generateSubtitles,
  "track.translate": translateTrack,
  "asset.ai-insights": aiInsights,
  "webhook.deliver": deliverWebhook,
  "live.segment": liveSegment,
  "live.finalize": liveFinalize,
  "live.simulcast": liveSimulcast,
  "uploads.sweep": sweepUploads,
  "usage.rollup": usageRollup,
};

const processor: Processor = async (job) => {
  const handler = handlers[job.name];
  if (!handler) throw new Error(`No handler for job ${job.name}`);
  return runWithJobWorkDir(job, () => handler(job));
};

async function checkTools() {
  const e = env();
  for (const [name, bin, arg] of [
    ["ffmpeg", e.FFMPEG_PATH, "-version"],
    ["ffprobe", e.FFPROBE_PATH, "-version"],
    ["packager", e.PACKAGER_PATH, "--version"],
  ] as const) {
    try {
      await run(bin, [arg], { timeoutMs: 10_000 });
    } catch {
      log.warn(`${name} not found at "${bin}"${name === "packager" ? " — DRM assets will fail until Shaka Packager is installed" : ""}`);
    }
  }
}

async function main() {
  const e = env();
  await fsp.mkdir(e.WORK_DIR, { recursive: true });
  await checkTools();

  // Which queues this process serves (lets you run dedicated transcode boxes): WORKER_QUEUES=video,ai
  const only = (process.env.WORKER_QUEUES ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const concurrency: Record<QueueName, number> = {
    video: e.TRANSCODE_CONCURRENCY,
    ai: Number(process.env.AI_CONCURRENCY ?? 2),
    webhooks: Number(process.env.WEBHOOK_CONCURRENCY ?? 20),
    live: Number(process.env.LIVE_CONCURRENCY ?? 50),
    maintenance: 2,
  };

  const workers: Worker[] = [];
  for (const name of Object.values(QUEUES)) {
    if (only.length && !only.includes(name)) continue;
    const w = new Worker(name, processor, {
      connection: bullConnection(),
      concurrency: concurrency[name],
      lockDuration: name === "video" ? 120_000 : 60_000,
      // Transcodes can run for hours; the lock is renewed automatically while the job is alive.
      maxStalledCount: 2,
    });
    w.on("failed", (job, err) => {
      log.warn({ queue: name, job: job?.name, id: job?.id, err: err.message }, "job failed");
      // A job failed for stalling (its worker died) never reaches the processor again: remove
      // what the dead attempt left on the work volume.
      if (job && isFinalFailure(job, err)) removeJobWorkDir(job).catch(() => {});
      // Final failure (including after a crash/stall): never leave an asset stuck in "preparing".
      if (job?.name === "asset.process" && isFinalFailure(job, err)) {
        markAssetErrored(job.data.assetId, err.message).catch(() => {});
      }
      // Same for a delivery whose worker died mid-request too often: it must not stay "pending".
      if (job?.name === "webhook.deliver" && isFinalFailure(job, err)) {
        getDb()
          .update(webhookDeliveries)
          .set({ status: "failed" })
          .where(and(eq(webhookDeliveries.id, job.data.deliveryId), eq(webhookDeliveries.status, "pending")))
          .catch(() => {});
      }
    });
    w.on("completed", (job) => log.info({ queue: name, job: job.name, id: job.id }, "job completed"));
    w.on("error", (err) => log.error({ queue: name, err: err.message }, "worker error"));
    workers.push(w);
    log.info(`serving queue "${name}" (concurrency ${concurrency[name]})`);
  }

  if (!only.length || only.includes("maintenance")) {
    const m = getQueue("maintenance");
    await m.upsertJobScheduler("uploads-sweep", { every: Number(process.env.UPLOAD_SWEEP_MS ?? 15_000) }, { name: "uploads.sweep", data: {} });
    await m.upsertJobScheduler("usage-rollup", { every: 3600_000 }, { name: "usage.rollup", data: {} });
  }

  const shutdown = async () => {
    log.info("shutting down workers (waiting for active jobs)");
    await Promise.all(workers.map((w) => w.close()));
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
