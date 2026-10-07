import type { FastifyBaseLogger } from "fastify";

/** Named repeatable sweeps. Modules register theirs at import time (orders tracking, task escalation, outbox, …). */
export interface Sweep {
  name: string;
  everyMs: number;
  run: (log: FastifyBaseLogger) => Promise<void>;
}

const sweeps = new Map<string, Sweep>();
export const sweepRegistry = {
  register(name: string, everyMs: number, run: Sweep["run"]) {
    sweeps.set(name, { name, everyMs, run });
  },
  get: (name: string) => sweeps.get(name),
  all: () => [...sweeps.values()],
};
