-- S2-F7: attachment metadata becomes real. The table existed since the MVP as
-- a seam and was never written, so the new NOT NULL columns need no backfill;
-- the DELETE below makes that assumption explicit instead of relying on it.
DELETE FROM "attachment_metadata";

ALTER TABLE "attachment_metadata"
  ADD COLUMN "projectId" TEXT NOT NULL,
  ADD COLUMN "storageProvider" TEXT NOT NULL,
  ALTER COLUMN "checksum" SET NOT NULL,
  ALTER COLUMN "storageKey" SET NOT NULL;

CREATE UNIQUE INDEX "attachment_metadata_storageKey_key" ON "attachment_metadata"("storageKey");
CREATE INDEX "attachment_metadata_organizationId_projectId_idx"
  ON "attachment_metadata"("organizationId", "projectId");
