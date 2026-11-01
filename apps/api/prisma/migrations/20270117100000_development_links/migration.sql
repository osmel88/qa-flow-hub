-- S5-F1 Development links.
--
-- Additive only. `development_artifacts` are internal records of development
-- activity (branch, commit, pull request, build, deployment), provider-neutral
-- so a GitHub/GitLab/Azure DevOps adapter can sync them later through
-- (provider, externalId). `work_item_development_links` relates them to work
-- items many-to-many. Both foreign keys carry projectId, so the database
-- refuses links across projects or tenants. Artifacts are soft-deleted;
-- unlinking deletes the row (link and unlink are in the audit log).

-- CreateEnum
CREATE TYPE "DevelopmentArtifactKind" AS ENUM ('branch', 'commit', 'pull_request', 'build', 'deployment');

-- CreateEnum
CREATE TYPE "DevelopmentProvider" AS ENUM ('local', 'github', 'gitlab', 'azure_devops', 'bitbucket');

-- CreateTable
CREATE TABLE "development_artifacts" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "kind" "DevelopmentArtifactKind" NOT NULL,
    "provider" "DevelopmentProvider" NOT NULL DEFAULT 'local',
    "externalId" TEXT,
    "naturalKey" TEXT NOT NULL,
    "url" TEXT,
    "title" TEXT,
    "branchName" TEXT,
    "commitSha" TEXT,
    "prNumber" INTEGER,
    "identifier" TEXT,
    "environment" TEXT,
    "status" TEXT,
    "occurredAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "development_artifacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_item_development_links" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "workItemId" TEXT NOT NULL,
    "artifactId" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "work_item_development_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "development_artifacts_organizationId_projectId_kind_idx" ON "development_artifacts"("organizationId", "projectId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "development_artifacts_id_projectId_key" ON "development_artifacts"("id", "projectId");

-- CreateIndex
CREATE INDEX "work_item_development_links_organizationId_projectId_idx" ON "work_item_development_links"("organizationId", "projectId");

-- CreateIndex
CREATE INDEX "work_item_development_links_artifactId_idx" ON "work_item_development_links"("artifactId");

-- CreateIndex
CREATE UNIQUE INDEX "work_item_development_links_workItemId_artifactId_key" ON "work_item_development_links"("workItemId", "artifactId");

-- No duplicate live artifact: one per (project, provider, kind, natural key),
-- and one per external id of a provider.
CREATE UNIQUE INDEX "development_artifacts_live_natural_key" ON "development_artifacts"("projectId", "provider", "kind", "naturalKey") WHERE "deletedAt" IS NULL;
CREATE UNIQUE INDEX "development_artifacts_live_external_id" ON "development_artifacts"("projectId", "provider", "kind", "externalId") WHERE "deletedAt" IS NULL AND "externalId" IS NOT NULL;

-- AddForeignKey
ALTER TABLE "development_artifacts" ADD CONSTRAINT "development_artifacts_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "development_artifacts" ADD CONSTRAINT "development_artifacts_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_item_development_links" ADD CONSTRAINT "work_item_development_links_workItemId_projectId_fkey" FOREIGN KEY ("workItemId", "projectId") REFERENCES "work_items"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_item_development_links" ADD CONSTRAINT "work_item_development_links_artifactId_projectId_fkey" FOREIGN KEY ("artifactId", "projectId") REFERENCES "development_artifacts"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;

-- Invariants the service also checks: each kind carries its own reference.
ALTER TABLE "development_artifacts" ADD CONSTRAINT "development_artifacts_reference" CHECK (
  ("kind" = 'branch' AND "branchName" IS NOT NULL)
  OR ("kind" = 'commit' AND "commitSha" IS NOT NULL)
  OR ("kind" = 'pull_request' AND "prNumber" IS NOT NULL AND "prNumber" > 0)
  OR ("kind" IN ('build', 'deployment') AND "identifier" IS NOT NULL)
);
ALTER TABLE "development_artifacts" ADD CONSTRAINT "development_artifacts_status" CHECK (
  "status" IS NULL
  OR ("kind" = 'branch' AND "status" IN ('active', 'merged', 'deleted'))
  OR ("kind" = 'pull_request' AND "status" IN ('draft', 'open', 'merged', 'closed'))
  OR ("kind" = 'build' AND "status" IN ('queued', 'running', 'succeeded', 'failed', 'cancelled'))
  OR ("kind" = 'deployment' AND "status" IN ('pending', 'in_progress', 'succeeded', 'failed', 'rolled_back'))
);

-- Row Level Security ---------------------------------------------------------

ALTER TABLE "development_artifacts" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "development_artifacts"
  USING ("organizationId" = current_setting('app.current_organization', true))
  WITH CHECK ("organizationId" = current_setting('app.current_organization', true));

REVOKE DELETE ON "development_artifacts" FROM qaflow_app;

ALTER TABLE "work_item_development_links" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "work_item_development_links"
  USING ("organizationId" = current_setting('app.current_organization', true))
  WITH CHECK ("organizationId" = current_setting('app.current_organization', true));
