type JobState = { attemptsMade: number; finishedOn?: number | null; opts: { attempts?: number } };

/**
 * True when BullMQ has given up on a job after a failure (the "failed" event fires for retries too).
 * attemptsMade alone is not enough: a job whose worker died more than maxStalledCount times is
 * failed with an UnrecoverableError ("job stalled more than allowable limit") while attemptsMade is
 * still below attempts. BullMQ sets finishedOn only when it moves a job to the failed set.
 */
export function isFinalFailure(job: JobState, err?: { name?: string } | null) {
  return job.finishedOn != null || err?.name === "UnrecoverableError" || job.attemptsMade >= (job.opts.attempts ?? 1);
}
