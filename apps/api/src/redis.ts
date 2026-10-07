import { Redis } from "ioredis";
import { getEnv } from "./env.js";

let client: Redis | undefined;

/** One shared ioredis connection -- never `new Redis()` per request. */
export function getRedis(): Redis {
  if (!client) {
    client = new Redis(getEnv().REDIS_URL);
  }
  return client;
}
