# Clinic EHR — agent instructions

You are building an ambulatory EHR + practice management system for US clinics with 2–25 providers.
This repo folder is the product spec. Read it before writing code; keep it true as you build.

## Read in this order
1. `docs/00-product-intent.md` — what we are building, for whom, and what we are not building
2. `docs/02-invariants.md` — rules that must never be broken (patient safety, privacy, money)
3. `docs/05-build-slices.md` — the order to build in and what "done" means per slice
4. `spec/*.yaml` — the structured spec (roles, modules, screens, flows, state machines, integrations)
5. `docs/07-ui-spec.md` then `spec/ui/*.yaml` — every screen's route, layout pattern, named elements, views and navigation
6. `docs/06-navigation.md` (generated) — navigation diagrams; `docs/08-backend-needs.md` (generated) — what each screen needs from the server
7. `docs/09-data-model.md` then `data/schema.prisma` — persistence model, tenancy, staging, FHIR mapping
8. `docs/10-hipaa-controls.md` — the controls every handler must implement
9. `api/openapi.yaml` (generated) with `docs/12-screen-api-map.md` — every operation and which screens call it; `docs/11-integrations.md` for vendor gateways
10. `docs/03-decisions.md` — why the architecture looks the way it does
11. `docs/04-open-questions.md` — things that are NOT decided
12. `docs/01-glossary.md` — domain terms; use these names in code

## Precedence when sources disagree
`02-invariants.md` > `spec/states.yaml` > `spec/flows.yaml` > `spec/screens.yaml` > `spec/ui/*.yaml` > `data/schema.prisma` and `spec/api/**` > wireframes > prose in other docs.
If two sources conflict, stop and add an entry to `04-open-questions.md` instead of picking one.

## IDs are the contract
Every role, screen, flow, flow step, state machine and invariant has a stable ID
(e.g. `encounter.rx`, `flow:encounter/05`, `INV-SAFE-02`).
- Reference IDs in branch names, commit messages, PR descriptions, test names and code comments where the code implements a spec item.
- Never rename or reuse an ID. Deprecate with `deprecated: true` and a pointer to its replacement.
- New screens/steps get new IDs added to the YAML in the same PR as the code.

## Do not invent
Clinical, billing and regulatory behaviour has real-world consequences.
- If the spec does not say how something should behave (a coding rule, a release delay, who may sign what), do not guess.
  Add a question to `04-open-questions.md`, implement the narrowest safe behaviour, and mark it `// OPEN-Qn` in code.
- External standards (X12, HL7 v2, NCPDP SCRIPT, FHIR US Core, C-CDA) are integrated through vendors or adapters. Do not hand-roll a certified function (eRx, EPCS, clearinghouse) unless a decision record says so.

## When you change behaviour
Update the spec in the same change: YAML for structure, docs for intent. Then run:

```
npm install
npm run validate
```

`validate` checks that every reference resolves (roles, screens, states, invariants, navigation targets, transitions), IDs are unique, every screen is reachable, the Prisma schema is valid, and the API covers every screen, every state transition (including the transition buttons in `spec/ui`) and every gateway. It must pass before a change is done. After changing `spec/ui`, run `npm run ui-docs`. After changing `data/schema.prisma` or `spec/api/**`, run `npm run api`.

## Building the API and database
- `api/openapi.yaml` is generated. Edit `spec/api/routes/*.yaml` (operations), `spec/api/dto.yaml` (request/response shapes) or `data/schema.prisma` (models), never the output.
- Implement each operation with the `operationId` as the handler name. Honour its extensions: `x-roles` (authorisation), `x-transitions` (only these state changes; reject anything not in `states.yaml`), `x-audit` (write this AuditEvent action), `x-step-up`, `x-invariants` (write a test per invariant), `x-integration` (call only through that gateway), `x-phi` (no body logging).
- Generate a typed client from `api/openapi.yaml` for the UI; do not hand-write fetch calls.
- Write RLS policies and append-only grants in migrations as described in `docs/09-data-model.md`. Prisma doesn't generate them.
- Use fake gateways until a vendor is confirmed (OPEN-Q2).

## Building UI from the spec
- Use element ids from `spec/ui` as `data-testid` values, e.g. `data-testid="encounter.orders/sign-orders"`.
- Build the patterns in `spec/ui/patterns.yaml` once and compose screens from them.
- Before building a screen, check its entry in `docs/08-backend-needs.md` against the available APIs. If an element's backend need isn't met, hide it behind a capability check and add an entry to `04-open-questions.md`; never fake server logic in the client.

## Vocabulary
Data entities use FHIR R4 resource names (Patient, Encounter, Condition, MedicationRequest, ServiceRequest, Observation, ...) as the domain vocabulary — see ADR-004. This does not mean the internal store is a FHIR server.

## Scope of the visual map
`ehr-ia-map.html` is a human-facing view of an earlier draft of this spec. The YAML is the source of truth. If they differ, the YAML wins.
