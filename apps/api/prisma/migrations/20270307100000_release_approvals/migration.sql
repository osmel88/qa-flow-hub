-- S6-F4 Release approvals.
--
-- Additive only. `release_approval_rules` says which approval types a
-- release needs (project-wide or for one environment) and how many.
-- `release_approvals` is the decision history: the application may insert
-- and mark a decision revoked, never edit what was decided or delete it.
-- The workflow state is derived on every read. Composite foreign keys with
-- projectId keep releases, environments and rules inside one project.

CREATE TABLE "release_approval_rules" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "environmentId" TEXT,
    "type" TEXT NOT NULL,
    "requiredApprovals" INTEGER NOT NULL DEFAULT 1,
    "allowSelfApproval" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    CONSTRAINT "release_approval_rules_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "release_approval_rules_type" CHECK ("type" IN ('qa', 'product', 'engineering', 'release_manager')),
    CONSTRAINT "release_approval_rules_required" CHECK ("requiredApprovals" BETWEEN 1 AND 10)
);

CREATE TABLE "release_approvals" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "releaseId" TEXT NOT NULL,
    "environmentId" TEXT,
    "type" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "comment" TEXT,
    "approverId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "revokedById" TEXT,
    "revokeReason" TEXT,
    CONSTRAINT "release_approvals_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "release_approvals_type" CHECK ("type" IN ('qa', 'product', 'engineering', 'release_manager')),
    CONSTRAINT "release_approvals_decision" CHECK ("decision" IN ('approved', 'rejected', 'changes_requested')),
    CONSTRAINT "release_approvals_comment" CHECK ("decision" = 'approved' OR length(btrim(coalesce("comment", ''))) >= 5),
    CONSTRAINT "release_approvals_revoked" CHECK (("revokedAt" IS NULL) = ("revokedById" IS NULL))
);

CREATE INDEX "release_approval_rules_organizationId_projectId_idx" ON "release_approval_rules"("organizationId", "projectId");
CREATE INDEX "release_approval_rules_environmentId_idx" ON "release_approval_rules"("environmentId");
-- One live rule per type and scope.
CREATE UNIQUE INDEX "release_approval_rules_live_type" ON "release_approval_rules"("projectId", coalesce("environmentId", ''), "type") WHERE "deletedAt" IS NULL;
CREATE INDEX "release_approvals_releaseId_environmentId_idx" ON "release_approvals"("releaseId", "environmentId");
-- One live decision per approver, type and scope: no duplicate approvals.
CREATE UNIQUE INDEX "release_approvals_live_decision" ON "release_approvals"("releaseId", coalesce("environmentId", ''), "type", "approverId") WHERE "revokedAt" IS NULL;

ALTER TABLE "release_approval_rules" ADD CONSTRAINT "release_approval_rules_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "release_approval_rules" ADD CONSTRAINT "release_approval_rules_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "release_approval_rules" ADD CONSTRAINT "release_approval_rules_environmentId_projectId_fkey" FOREIGN KEY ("environmentId", "projectId") REFERENCES "environments"("id", "projectId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "release_approvals" ADD CONSTRAINT "release_approvals_releaseId_projectId_fkey" FOREIGN KEY ("releaseId", "projectId") REFERENCES "releases"("id", "projectId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "release_approvals" ADD CONSTRAINT "release_approvals_environmentId_projectId_fkey" FOREIGN KEY ("environmentId", "projectId") REFERENCES "environments"("id", "projectId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Row Level Security ---------------------------------------------------------

ALTER TABLE "release_approval_rules" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "release_approval_rules"
  USING ("organizationId" = current_setting('app.current_organization', true))
  WITH CHECK ("organizationId" = current_setting('app.current_organization', true));
REVOKE DELETE ON "release_approval_rules" FROM qaflow_app;

-- Decisions: insert, and mark revoked; nothing else.
ALTER TABLE "release_approvals" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "release_approvals"
  USING ("organizationId" = current_setting('app.current_organization', true))
  WITH CHECK ("organizationId" = current_setting('app.current_organization', true));
REVOKE UPDATE, DELETE ON "release_approvals" FROM qaflow_app;
GRANT UPDATE ("revokedAt", "revokedById", "revokeReason") ON "release_approvals" TO qaflow_app;
