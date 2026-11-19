/**
 * Runs the dependency checks behind /health, each with a deadline. ioredis queues commands while
 * it is disconnected (BullMQ needs maxRetriesPerRequest: null), so a PING during a Redis outage
 * never settles: without a deadline /health hung for the whole outage instead of answering 503.
 */
export async function checkHealth(
  checks: Record<string, () => Promise<unknown>>,
  timeoutMs = 2000,
): Promise<{ ok: boolean; failures: Record<string, string> }> {
  const failures: Record<string, string> = {};
  await Promise.all(
    Object.entries(checks).map(async ([name, check]) => {
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          check(),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`no answer within ${timeoutMs} ms`)), timeoutMs);
          }),
        ]);
      } catch (err) {
        failures[name] = err instanceof Error ? err.message : String(err);
      } finally {
        clearTimeout(timer);
      }
    }),
  );
  return { ok: Object.keys(failures).length === 0, failures };
}
