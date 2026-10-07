import type { FastifyBaseLogger } from "fastify";
import { Queue, Worker } from "bullmq";
import { getEnv } from "../env.js";
import { forEachPractice } from "./tenants.js";
import {
  endOfDayNoShows,
  eligibilityBatch,
  expireWaitlistOffers,
  sendReminders,
} from "./sweeps.js";
import { sweepRegistry } from "./registry.js";

/**
 * Repeatable background jobs on BullMQ (agile-emr's queue library) with the shared Redis. One queue, one job name
 * per sweep. Every sweep runs tenant by tenant under RLS (workers/tenants.ts).
 */
const QUEUE = "emr-sweeps";

function connection() {
  const url = new URL(getEnv().REDIS_URL);
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
  };
}

sweepRegistry.register("reminders", 15 * 60_000, async (log) => {
  await forEachPractice(
    async (tx, p) => {
      const after: Array<() => Promise<void>> = [];
      await sendReminders(tx, p, (fn) => after.push(fn));
      // Sends run after the tenant transaction commits.
      setImmediate(
        () =>
          void Promise.all(
            after.map((f) => f().catch((e) => log.error({ err: e }, "reminder send failed"))),
          ),
      );
    },
    (e, id) => log.error({ err: e, practiceId: id }, "reminder sweep failed"),
  );
});
sweepRegistry.register("eligibility-batch", 60 * 60_000, async (log) => {
  await forEachPractice(
    (tx, p) => eligibilityBatch(tx, p).then(() => undefined),
    (e, id) => log.error({ err: e, practiceId: id }, "eligibility batch failed"),
  );
});
sweepRegistry.register("end-of-day-no-shows", 30 * 60_000, async (log) => {
  await forEachPractice(
    (tx, p) => endOfDayNoShows(tx, p).then(() => undefined),
    (e, id) => log.error({ err: e, practiceId: id }, "no-show sweep failed"),
  );
});
sweepRegistry.register("waitlist-offer-expiry", 10 * 60_000, async (log) => {
  await forEachPractice(
    (tx) => expireWaitlistOffers(tx).then(() => undefined),
    (e, id) => log.error({ err: e, practiceId: id }, "waitlist expiry failed"),
  );
});

export async function startWorkers(log: FastifyBaseLogger): Promise<void> {
  const queue = new Queue(QUEUE, { connection: connection() });
  for (const s of sweepRegistry.all()) {
    // bullmq 6: job schedulers replace `repeat`; upsert keeps restarts from duplicating them.
    await queue.upsertJobScheduler(
      s.name,
      { every: s.everyMs },
      { name: s.name, data: {}, opts: { removeOnComplete: 50, removeOnFail: 100 } },
    );
  }
  new Worker(
    QUEUE,
    async (job) => {
      const s = sweepRegistry.get(job.name);
      if (s) await s.run(log);
    },
    { connection: connection(), concurrency: 1 },
  );
  log.info({ sweeps: sweepRegistry.all().map((s) => s.name) }, "background sweeps scheduled");
}
