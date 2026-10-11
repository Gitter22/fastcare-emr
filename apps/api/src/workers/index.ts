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
import { flagOverdueOrders } from "../modules/orders/tracking.js";
import { escalateCriticalResults } from "../modules/results/ingest.js";
import { runSimulatedLab } from "../modules/results/simulatedLab.js";
import { runClaimBatch, runSimulatedClearinghouse } from "../modules/rcm/inbound.js";
import { runPaymentPlanAutopay } from "../modules/rcm/accounts.js";

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

// INV-SAFE-07: orders past their expected-by date without a result.
sweepRegistry.register("orders-overdue", 60 * 60_000, async (log) => {
  await forEachPractice(
    (tx, p) => flagOverdueOrders(tx, p.id).then(() => undefined),
    (e, id) => log.error({ err: e, practiceId: id }, "overdue order sweep failed"),
  );
});
// INV-SAFE-04: critical results not communicated in time escalate.
sweepRegistry.register("critical-result-escalation", 5 * 60_000, async (log) => {
  await forEachPractice(
    (tx, p) => escalateCriticalResults(tx, p.id).then(() => undefined),
    (e, id) => log.error({ err: e, practiceId: id }, "critical result escalation failed"),
  );
});
// flow:rcm/03: ready claims go to the clearinghouse in batches.
sweepRegistry.register("claims-batch", 30 * 60_000, async (log) => {
  await forEachPractice(
    (tx, p) => runClaimBatch(tx, p.id).then(() => undefined),
    (e, id) => log.error({ err: e, practiceId: id }, "claim batch failed"),
  );
});
// flow:rcm/08: payment-plan installments on autopay.
sweepRegistry.register("payment-plan-autopay", 60 * 60_000, async (log) => {
  await forEachPractice(
    (tx, p) => runPaymentPlanAutopay(tx, p.id).then(() => undefined),
    (e, id) => log.error({ err: e, practiceId: id }, "payment plan autopay failed"),
  );
});
if (getEnv().NODE_ENV === "development")
  sweepRegistry.register("simulated-clearinghouse", 60_000, async (log) => {
    await forEachPractice(
      (tx, p) => runSimulatedClearinghouse(tx, p.id).then(() => undefined),
      (e, id) => log.error({ err: e, practiceId: id }, "simulated clearinghouse failed"),
    );
  });
if (getEnv().NODE_ENV === "development")
  sweepRegistry.register("simulated-lab", 60_000, async (log) => {
    await forEachPractice(
      (tx, p) => runSimulatedLab(tx, p.id).then(() => undefined),
      (e, id) => log.error({ err: e, practiceId: id }, "simulated lab failed"),
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
