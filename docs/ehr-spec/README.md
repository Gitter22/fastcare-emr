# Clinic EHR spec

Product spec for an ambulatory EHR + practice management system, written for humans and coding agents.

```
CLAUDE.md                 agent entry point: reading order, precedence, rules
docs/00-product-intent    scope, principles, non-goals
docs/01-glossary          domain terms and code names
docs/02-invariants        rules that must never break, with test hints
docs/03-decisions         ADRs: why the architecture looks this way
docs/04-open-questions    undecided items; agents add here instead of guessing
docs/05-build-slices      build order and definition of done
docs/06-navigation        GENERATED navigation diagrams (Mermaid) and incoming links
docs/07-ui-spec           how spec/ui works: screens, elements, views, navigation rules
docs/08-backend-needs     GENERATED reads/writes/server logic per screen, for API mapping
docs/09-data-model        schema conventions, tags, tenancy (RLS), staging, files, FHIR mapping, retention
docs/10-hipaa-controls    HIPAA safeguards mapped to schema and API
docs/11-integrations      gateways, vendors, reference data, webhook and retry rules
docs/12-screen-api-map    GENERATED operations each screen calls
data/schema.prisma        PostgreSQL data model (Prisma)
spec/api/                 API source: routes/*.yaml, dto.yaml, params.yaml, fhir.yaml
api/openapi.yaml          GENERATED OpenAPI 3.1 (app API, auth, portal, webhooks, OAuth, FHIR R4)
spec/*.yaml               roles, modules, screens, flows, state machines, invariants, integrations, slices
spec/ui/*.yaml            every screen: route, pattern, regions, named elements, views, navigation
tools/validate.mjs        referential integrity check
tools/build-openapi.mjs   compiles schema + spec/api into api/openapi.yaml and checks API coverage
tools/prisma-check.mjs    validates data/schema.prisma offline
ehr-ia-map.html           visual map (human view of an earlier draft; YAML wins)
```

## Use
```
npm install
npm run validate   # spec refs, Prisma schema, API coverage; must pass before any change is done
npm run ui-docs    # regenerates docs/06 and docs/08 from spec/ui
npm run api        # regenerates api/openapi.yaml and docs/12, then lints with Redocly
npm run bundle     # writes dist/spec.json
```

## Put it in your code repo
Copy this folder to `/spec` (or `/docs/spec`) in the app repo and point the repo's root `CLAUDE.md` at it:

```
Product spec lives in /spec. Read /spec/CLAUDE.md before any feature work.
```

## Starting the agent
Answer OPEN-Q1 (stack) first, then give the agent one slice at a time, e.g.:

> Read spec/CLAUDE.md and follow its reading order. Propose a plan for slice S0 only: modules, data model, and the tests you will write for each invariant in S0. Do not write code until I approve the plan.
