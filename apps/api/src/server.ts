import { buildApp } from "./app.js";
import { getEnv } from "./env.js";
import { startWorkers } from "./workers/index.js";

async function main() {
  const env = getEnv();
  const app = await buildApp();

  try {
    await app.listen({ port: env.PORT, host: "0.0.0.0" });
    app.log.info(`apps/api listening on :${env.PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  // Background workers (outbox delivery, retries, escalation and end-of-day sweeps, eligibility batch, reminders,
  // downtime snapshot). Started only for the running server, not for tests that call buildApp() directly. A
  // scheduling failure must not take down request serving, so it is logged loudly instead of thrown (same rule as
  // agile-emr's server.ts).
  try {
    await startWorkers(app.log);
  } catch (err) {
    app.log.error(
      { err },
      "Failed to start background workers -- the API is serving, but queued work will not run until this is fixed",
    );
  }
}

void main();
