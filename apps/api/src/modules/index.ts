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
import { integrationHandlers } from "./admin/integrations.js";
import { allergyHandlers } from "./clinical/allergies.js";
import { conditionHandlers } from "./clinical/conditions.js";
import { immunizationHandlers } from "./clinical/immunizations.js";
import { medicationHandlers } from "./clinical/medications.js";
import { observationHandlers } from "./clinical/observations.js";
import { questionnaireHandlers } from "./clinical/questionnaires.js";
import { referenceHandlers } from "./clinical/reference.js";
import { summaryHandlers } from "./clinical/summary.js";
import { avsHandlers } from "./encounters/avs.js";
import { diagnosisHandlers } from "./encounters/diagnoses.js";
import { encounterHandlers } from "./encounters/handlers.js";
import { noteHandlers } from "./encounters/notes/handlers.js";
import { clinicalWorkspaceHandlers } from "./workspace/clinical.js";
import { catalogHandlers } from "./orders/catalog.js";
import { collectionHandlers } from "./orders/collection.js";
import { orderHandlers } from "./orders/handlers.js";
import { trackingHandlers } from "./orders/tracking.js";
import { resultHandlers } from "./results/handlers.js";

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
  ...integrationHandlers,
  ...referenceHandlers,
  ...conditionHandlers,
  ...allergyHandlers,
  ...medicationHandlers,
  ...observationHandlers,
  ...questionnaireHandlers,
  ...immunizationHandlers,
  ...summaryHandlers,
  ...encounterHandlers,
  ...diagnosisHandlers,
  ...noteHandlers,
  ...avsHandlers,
  ...clinicalWorkspaceHandlers,
  ...catalogHandlers,
  ...orderHandlers,
  ...collectionHandlers,
  ...trackingHandlers,
  ...resultHandlers,
};
