-- S5-F3 Code review.
--
-- Additive only. `code_reviews` are internal, provider-neutral reviews of a
-- project, optionally of a (local) pull request artifact; a GitHub/GitLab
-- adapter can sync them later through (provider, externalId).
-- `code_review_reviewers` holds one decision per reviewer,
-- `code_review_work_items` relates reviews to work items, and
-- `code_review_events` is the append-only history (decisions and comments).
-- Every foreign key to a project resource carries projectId, so the database
-- refuses anything across projects or tenants. Reviews are soft-deleted.

CREATE TYPE "CodeReviewStatus" AS ENUM ('pending', 'in_review', 'changes_requested', 'approved', 'dismissed');
CREATE TYPE "CodeReviewDecision" AS ENUM ('pending', 'approved', 'changes_requested', 'dismissed');

CREATE TABLE "code_reviews" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "status" "CodeReviewStatus" NOT NULL DEFAULT 'pending',
    "authorId" TEXT NOT NULL,
    "pullRequestId" TEXT,
    "requiredApprovals" INTEGER,
    "provider" "DevelopmentProvider" NOT NULL DEFAULT 'local',
    "externalId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    CONSTRAINT "code_reviews_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "code_reviews_required_approvals" CHECK ("requiredApprovals" IS NULL OR "requiredApprovals" BETWEEN 1 AND 20)
);

CREATE TABLE "code_review_reviewers" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "reviewId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "decision" "CodeReviewDecision" NOT NULL DEFAULT 'pending',
    "comment" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "code_review_reviewers_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "code_review_work_items" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "reviewId" TEXT NOT NULL,
    "workItemId" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "code_review_work_items_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "code_review_events" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "reviewId" TEXT NOT NULL,
    "actorId" TEXT,
    "kind" TEXT NOT NULL,
    "subjectId" TEXT,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "code_review_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "code_review_settings" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "requiredApprovals" INTEGER NOT NULL DEFAULT 1,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "code_review_settings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "code_review_settings_required_approvals" CHECK ("requiredApprovals" BETWEEN 1 AND 20)
);

CREATE UNIQUE INDEX "code_reviews_id_projectId_key" ON "code_reviews"("id", "projectId");
CREATE INDEX "code_reviews_organizationId_projectId_status_idx" ON "code_reviews"("organizationId", "projectId", "status");
CREATE INDEX "code_reviews_pullRequestId_idx" ON "code_reviews"("pullRequestId");
CREATE UNIQUE INDEX "code_reviews_live_external_id" ON "code_reviews"("projectId", "provider", "externalId") WHERE "deletedAt" IS NULL AND "externalId" IS NOT NULL;
CREATE UNIQUE INDEX "code_review_reviewers_reviewId_userId_key" ON "code_review_reviewers"("reviewId", "userId");
CREATE INDEX "code_review_reviewers_organizationId_userId_idx" ON "code_review_reviewers"("organizationId", "userId");
CREATE UNIQUE INDEX "code_review_work_items_reviewId_workItemId_key" ON "code_review_work_items"("reviewId", "workItemId");
CREATE INDEX "code_review_work_items_workItemId_idx" ON "code_review_work_items"("workItemId");
CREATE INDEX "code_review_events_reviewId_createdAt_idx" ON "code_review_events"("reviewId", "createdAt");
CREATE UNIQUE INDEX "code_review_settings_projectId_key" ON "code_review_settings"("projectId");

ALTER TABLE "code_reviews" ADD CONSTRAINT "code_reviews_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "code_reviews" ADD CONSTRAINT "code_reviews_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "code_reviews" ADD CONSTRAINT "code_reviews_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "code_reviews" ADD CONSTRAINT "code_reviews_pullRequestId_projectId_fkey" FOREIGN KEY ("pullRequestId", "projectId") REFERENCES "development_artifacts"("id", "projectId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "code_review_reviewers" ADD CONSTRAINT "code_review_reviewers_reviewId_projectId_fkey" FOREIGN KEY ("reviewId", "projectId") REFERENCES "code_reviews"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "code_review_reviewers" ADD CONSTRAINT "code_review_reviewers_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "code_review_work_items" ADD CONSTRAINT "code_review_work_items_reviewId_projectId_fkey" FOREIGN KEY ("reviewId", "projectId") REFERENCES "code_reviews"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "code_review_work_items" ADD CONSTRAINT "code_review_work_items_workItemId_projectId_fkey" FOREIGN KEY ("workItemId", "projectId") REFERENCES "work_items"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "code_review_events" ADD CONSTRAINT "code_review_events_reviewId_projectId_fkey" FOREIGN KEY ("reviewId", "projectId") REFERENCES "code_reviews"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "code_review_settings" ADD CONSTRAINT "code_review_settings_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "code_review_settings" ADD CONSTRAINT "code_review_settings_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row Level Security ---------------------------------------------------------

ALTER TABLE "code_reviews" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "code_reviews"
  USING ("organizationId" = current_setting('app.current_organization', true))
  WITH CHECK ("organizationId" = current_setting('app.current_organization', true));
REVOKE DELETE ON "code_reviews" FROM qaflow_app;

ALTER TABLE "code_review_reviewers" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "code_review_reviewers"
  USING ("organizationId" = current_setting('app.current_organization', true))
  WITH CHECK ("organizationId" = current_setting('app.current_organization', true));

ALTER TABLE "code_review_work_items" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "code_review_work_items"
  USING ("organizationId" = current_setting('app.current_organization', true))
  WITH CHECK ("organizationId" = current_setting('app.current_organization', true));

-- History is append-only for the application.
ALTER TABLE "code_review_events" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "code_review_events"
  USING ("organizationId" = current_setting('app.current_organization', true))
  WITH CHECK ("organizationId" = current_setting('app.current_organization', true));
REVOKE UPDATE, DELETE ON "code_review_events" FROM qaflow_app;

ALTER TABLE "code_review_settings" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "code_review_settings"
  USING ("organizationId" = current_setting('app.current_organization', true))
  WITH CHECK ("organizationId" = current_setting('app.current_organization', true));
REVOKE DELETE ON "code_review_settings" FROM qaflow_app;
