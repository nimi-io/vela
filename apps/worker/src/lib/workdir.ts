import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { env } from "@vela/core";

type JobRef = { queueName: string; id?: string | null };

/**
 * Work directory of one job, named after the job rather than randomly. A worker killed mid-job
 * (SIGKILL, OOM, power loss) never runs its `finally` cleanup; with random names its files stayed
 * on the shared work volume forever. With a per-job directory, whoever finishes the job (the attempt
 * that completes it, or the "failed" listener when no attempt is left) removes everything earlier,
 * killed attempts left behind.
 *
 * Each attempt still works in its own subdirectory. Two attempts of one job can overlap: a worker
 * that lost its lock (event loop stalled, host suspended) keeps running while BullMQ hands the job
 * to another worker. Sharing one directory let them delete each other's files mid-run.
 */
export function jobWorkDir(job: JobRef, root = env().WORK_DIR) {
  const id = String(job.id ?? "unknown").replace(/[^A-Za-z0-9_.-]/g, "_");
  return path.join(root, `job-${job.queueName}-${id}`);
}

const attemptDirs = new WeakMap<object, string[]>();

/** Creates a directory for this attempt of the job (under the job's directory). */
export async function makeJobWorkDir(job: JobRef, root = env().WORK_DIR) {
  const dir = path.join(jobWorkDir(job, root), `attempt-${randomUUID().slice(0, 8)}`);
  await fsp.mkdir(dir, { recursive: true });
  attemptDirs.set(job, [...(attemptDirs.get(job) ?? []), dir]);
  return dir;
}

/** Removes the job's directory, including what any earlier attempt left. */
export async function removeJobWorkDir(job: JobRef, root = env().WORK_DIR) {
  await fsp.rm(jobWorkDir(job, root), { recursive: true, force: true });
}

/**
 * Runs one attempt of a job. When it fails (and may be retried) only this attempt's directories are
 * removed; when it completes the job is done, so the whole job directory goes.
 */
export async function runWithJobWorkDir<T>(job: JobRef, fn: () => Promise<T>, root = env().WORK_DIR): Promise<T> {
  let completed = false;
  try {
    const result = await fn();
    completed = true;
    return result;
  } finally {
    const own = attemptDirs.get(job) ?? [];
    attemptDirs.delete(job);
    if (completed) await removeJobWorkDir(job, root).catch(() => {});
    else await Promise.all(own.map((d) => fsp.rm(d, { recursive: true, force: true }).catch(() => {})));
  }
}
