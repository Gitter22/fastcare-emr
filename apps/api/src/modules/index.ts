import type { HandlerMap } from "../platform/http/context.js";
import { organisationHandlers } from "./admin/organisation.js";
import { securityHandlers } from "./admin/security.js";
import { userHandlers } from "./admin/users.js";
import { authHandlers } from "./auth/handlers.js";
import { patientHandlers } from "./patients/handlers.js";
import { workspaceHandlers } from "./workspace/handlers.js";
import { schedulingHandlers } from "./scheduling/handlers.js";
import { frontDeskBillingHandlers } from "./billing/frontdesk.js";
import { schedulingSetupHandlers } from "./admin/schedulingSetup.js";
import { payerHandlers } from "./admin/payers.js";

/** Every module's operation handlers, keyed by operationId (api/openapi.yaml). */
export const handlers: HandlerMap = {
  ...authHandlers,
  ...patientHandlers,
  ...userHandlers,
  ...securityHandlers,
  ...organisationHandlers,
  ...workspaceHandlers,
  ...schedulingHandlers,
  ...frontDeskBillingHandlers,
  ...schedulingSetupHandlers,
  ...payerHandlers,
};
