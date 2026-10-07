import type { FastifyBaseLogger } from "fastify";

export async function startWorkers(log: FastifyBaseLogger): Promise<void> {
  log.info("workers: none registered yet");
}
