-- Fuzzy patient search (patients.search: "fuzzy match"). Both extensions are trusted (PG13+), so the database owner
-- can create them without superuser.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS fuzzystrmatch;

CREATE INDEX IF NOT EXISTS "Patient_lastName_trgm" ON "Patient" USING gin (lower("lastName") gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Patient_firstName_trgm" ON "Patient" USING gin (lower("firstName") gin_trgm_ops);
