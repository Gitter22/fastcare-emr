import type { HandlerMap } from "../platform/http/context.js";
import { authHandlers } from "./auth/handlers.js";

/** Every module's operation handlers, keyed by operationId (api/openapi.yaml). */
export const handlers: HandlerMap = {
  ...authHandlers,
};
