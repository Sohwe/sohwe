-- Add public image sources and isolated preview applications without changing
-- existing Git applications or their deployments.
ALTER TABLE "applications"
  ADD COLUMN "image_ref" TEXT,
  ADD COLUMN "preview_of_id" TEXT;

CREATE INDEX "applications_preview_of_id_idx" ON "applications"("preview_of_id");

ALTER TABLE "applications"
  ADD CONSTRAINT "applications_preview_of_id_fkey"
  FOREIGN KEY ("preview_of_id") REFERENCES "applications"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
