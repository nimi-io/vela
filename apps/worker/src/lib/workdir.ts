import fsp from "node:fs/promises";
import path from "node:path";
import { env } from "@vela/core";

type JobRef = { queueName: string; id?: string | null };

/**
 * Work directory of one job, named after the job rather than randomly. A worker killed mid-job
 * (SIGKILL, OOM, power loss) never runs its `finally` cleanup; with random names its files stayed
 * on the shared work volume forever. With a per-job name, the worker that runs the job's next
 * attempt (BullMQ hands it to exactly one worker once the dead worker's lock expires) or that
 * records its final failure can find and remove them.
 */
export function jobWorkDir(job: JobRef, root = env().WORK_DIR) {
  const id = String(job.id ?? "unknown").replace(/[^A-Za-z0-9_.-]/g, "_");
  return path.join(root, `job-${job.queueName}-${id}`);
}

/** Creates the job's work directory. */
export async function makeJobWorkDir(job: JobRef, root = env().WORK_DIR) {
  const dir = jobWorkDir(job, root);
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

export async function removeJobWorkDir(job: JobRef, root = env().WORK_DIR) {
  await fsp.rm(jobWorkDir(job, root), { recursive: true, force: true });
}

/**
 * Runs one attempt of a job: first removes what an earlier, killed attempt of the same job left,
 * then always removes the job's directory when the attempt ends.
 */
export async function runWithJobWorkDir<T>(job: JobRef, fn: () => Promise<T>, root = env().WORK_DIR): Promise<T> {
  await removeJobWorkDir(job, root);
  try {
    return await fn();
  } finally {
    await removeJobWorkDir(job, root).catch(() => {});
  }
}
