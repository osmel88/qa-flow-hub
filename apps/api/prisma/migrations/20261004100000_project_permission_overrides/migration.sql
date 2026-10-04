-- S2-F8: granular permissions as project-level overrides on top of roles.
--
-- No backfill: the absence of a row means "the effective project role decides",
-- which is exactly the pre-S2-F8 behaviour. The role → permission mapping lives
-- in code (packages/shared, ROLE_PERMISSIONS) and is documented in
-- docs/permissions-matrix.md.

CREATE TYPE "PermissionEffect" AS ENUM ('grant', 'revoke');

CREATE TABLE "project_permission_overrides" (
  "id"             TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "projectId"      TEXT NOT NULL,
  "userId"         TEXT NOT NULL,
  "permission"     TEXT NOT NULL,
  "effect"         "PermissionEffect" NOT NULL,
  "grantedById"    TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,

  CONSTRAINT "project_permission_overrides_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "project_permission_overrides_projectId_userId_permission_key"
  ON "project_permission_overrides"("projectId", "userId", "permission");
CREATE INDEX "project_permission_overrides_organizationId_userId_idx"
  ON "project_permission_overrides"("organizationId", "userId");
CREATE INDEX "project_permission_overrides_organizationId_projectId_idx"
  ON "project_permission_overrides"("organizationId", "projectId");

ALTER TABLE "project_permission_overrides"
  ADD CONSTRAINT "project_permission_overrides_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "project_permission_overrides"
  ADD CONSTRAINT "project_permission_overrides_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "project_permission_overrides"
  ADD CONSTRAINT "project_permission_overrides_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "project_permission_overrides"
  ADD CONSTRAINT "project_permission_overrides_grantedById_fkey"
  FOREIGN KEY ("grantedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Read on the authorization path, so it gets the same second layer of tenant
-- isolation as project_members.
ALTER TABLE "project_permission_overrides" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "project_permission_overrides"
  USING ("organizationId" = current_setting('app.current_organization', true))
  WITH CHECK ("organizationId" = current_setting('app.current_organization', true));
