-- Integration Settings (S2-F1).
--
-- Adds the connection state the settings screen edits. No credential storage:
-- `secretRef` stays a reference to a secret manager that does not exist yet, and
-- the encrypted credential store is S2-F4's deliverable.

-- `pending` is a saved, enabled configuration whose provider has no
-- implementation yet. Without it the only honest option is `error`, which would
-- report a failure that never happened.
ALTER TYPE "IntegrationStatus" ADD VALUE IF NOT EXISTS 'pending' BEFORE 'connected';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'IntegrationMode') THEN
    CREATE TYPE "IntegrationMode" AS ENUM ('mock', 'real');
  END IF;
END
$$;

ALTER TABLE "integration_connections"
  ADD COLUMN "mode" "IntegrationMode" NOT NULL DEFAULT 'mock',
  ADD COLUMN "enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "accountMetadata" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "lastConnectionTestAt" TIMESTAMP(3);

-- One connection per provider per organization. The previous constraint allowed
-- several rows for the same provider, which the settings screen has no way to
-- disambiguate: it edits a provider, not a list.
DROP INDEX IF EXISTS "integration_connections_organizationId_provider_displayName_key";

CREATE UNIQUE INDEX "integration_connections_organizationId_provider_key"
  ON "integration_connections" ("organizationId", "provider");
