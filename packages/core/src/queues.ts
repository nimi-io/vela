import { Queue, type JobsOptions, type ConnectionOptions } from "bullmq";
import { Redis } from "ioredis";
import { env } from "./env.js";

export const QUEUES = {
  video: "video", // heavy: ingest, transcode, package
  ai: "ai", // captions, translations, summaries
  webhooks: "webhooks",
  live: "live", // recording segments, finalize, simulcast
  maintenance: "maintenance",
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export type JobPayloads = {
  "asset.process": { assetId: string };
  "asset.static-renditions": { assetId: string };
  "asset.delete": { assetId: string };
  "track.ingest": { assetId: string; trackId: string; url: string };
  "track.generate-subtitles": { assetId: string; trackId: string };
  "track.translate": { assetId: string; trackId: string; sourceTrackId: string };
  "asset.ai-insights": { assetId: string };
  "webhook.deliver": { deliveryId: string };
  "live.segment": { liveStreamId: string; sessionId: string; path: string };
  "live.finalize": { liveStreamId: string; sessionId: string };
  "live.simulcast": { liveStreamId: string; targetId: string; sessionId: string };
  "uploads.sweep": Record<string, never>;
  "usage.rollup": Record<string, never>;
};

export type JobName = keyof JobPayloads;

const JOB_QUEUE: Record<JobName, QueueName> = {
  "asset.process": "video",
  "asset.static-renditions": "video",
  "track.ingest": "video",
  "asset.delete": "maintenance",
  "track.generate-subtitles": "ai",
  "track.translate": "ai",
  "asset.ai-insights": "ai",
  "webhook.deliver": "webhooks",
  "live.segment": "live",
  "live.finalize": "live",
  "live.simulcast": "live",
  "uploads.sweep": "maintenance",
  "usage.rollup": "maintenance",
};

let connection: Redis | undefined;

/** Shared ioredis connection (BullMQ requires maxRetriesPerRequest: null). */
export function redis(): Redis {
  return (connection ??= new Redis(env().REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: true }));
}

export function bullConnection(): ConnectionOptions {
  return redis() as unknown as ConnectionOptions;
}

const queues = new Map<QueueName, Queue>();

export function getQueue(name: QueueName): Queue {
  let q = queues.get(name);
  if (!q) {
    q = new Queue(name, {
      connection: bullConnection(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 5000 },
        removeOnComplete: { age: 24 * 3600, count: 5000 },
        removeOnFail: { age: 7 * 24 * 3600 },
      },
    });
    queues.set(name, q);
  }
  return q;
}

export async function enqueue<N extends JobName>(name: N, data: JobPayloads[N], opts: JobsOptions = {}) {
  return getQueue(JOB_QUEUE[name]).add(name, data, opts);
}

export async function closeQueues() {
  await Promise.all([...queues.values()].map((q) => q.close()));
  queues.clear();
  await connection?.quit().catch(() => {});
  connection = undefined;
}
