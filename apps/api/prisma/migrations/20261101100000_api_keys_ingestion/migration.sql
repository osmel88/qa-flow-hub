-- S3-F3 API keys and automated result ingestion.
--
-- Additive only. `api_keys` stores the SHA-256 of each machine credential,
-- never the secret; `ingestion_reports` records every accepted report once per
-- (project, idempotency key), which is what makes a resubmission a no-op.

-- AlterEnum
ALTER TYPE "AuditAction" ADD VALUE 'revoke';

-- CreateEnum
CREATE TYPE "ApiKeyScope" AS ENUM ('results_ingest');

-- CreateEnum
CREATE TYPE "IngestionFormat" AS ENUM ('junit_xml', 'playwright_json');

-- CreateTable
CREATE TABLE "api_keys" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "secretHash" TEXT NOT NULL,
    "scopes" "ApiKeyScope"[],
    "expiresAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokedById" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ingestion_reports" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "apiKeyId" TEXT,
    "format" "IngestionFormat" NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "checksum" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileSizeBytes" INTEGER NOT NULL,
    "testRunId" TEXT,
    "summary" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ingestion_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_prefix_key" ON "api_keys"("prefix");

-- CreateIndex
CREATE INDEX "api_keys_organizationId_projectId_createdAt_idx" ON "api_keys"("organizationId", "projectId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ingestion_reports_projectId_idempotencyKey_key" ON "ingestion_reports"("projectId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "ingestion_reports_organizationId_projectId_createdAt_idx" ON "ingestion_reports"("organizationId", "projectId", "createdAt");

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_revokedById_fkey" FOREIGN KEY ("revokedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingestion_reports" ADD CONSTRAINT "ingestion_reports_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingestion_reports" ADD CONSTRAINT "ingestion_reports_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingestion_reports" ADD CONSTRAINT "ingestion_reports_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "api_keys"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingestion_reports" ADD CONSTRAINT "ingestion_reports_testRunId_fkey" FOREIGN KEY ("testRunId") REFERENCES "test_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Row Level Security ---------------------------------------------------------

ALTER TABLE "api_keys" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "api_keys"
  USING ("organizationId" = current_setting('app.current_organization', true))
  WITH CHECK ("organizationId" = current_setting('app.current_organization', true));

ALTER TABLE "ingestion_reports" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ingestion_reports"
  USING ("organizationId" = current_setting('app.current_organization', true))
  WITH CHECK ("organizationId" = current_setting('app.current_organization', true));

-- API key tenant resolution ------------------------------------------------
--
-- An ingestion request carries a key, not an organization, and arrives before
-- any tenant is known, so RLS hides every api_keys row from it. This function
-- answers only "which organization owns this prefix"; the hash comparison, the
-- revocation and the expiry checks happen afterwards, under RLS, in the API.
-- Same shape as billing_organization_for_customer.
CREATE FUNCTION api_key_organization_for_prefix(p_prefix TEXT)
  RETURNS TEXT
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  SELECT k."organizationId"
  FROM "api_keys" k
  JOIN "organizations" o ON o."id" = k."organizationId" AND o."deletedAt" IS NULL
  WHERE k."prefix" = p_prefix
$$;

REVOKE ALL ON FUNCTION api_key_organization_for_prefix(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api_key_organization_for_prefix(TEXT) TO qaflow_app;

-- A key is revoked, never deleted: its prefix must not be reissued and its
-- reports keep pointing at it. Reports are history.
REVOKE DELETE ON "api_keys" FROM qaflow_app;
REVOKE DELETE ON "ingestion_reports" FROM qaflow_app;
