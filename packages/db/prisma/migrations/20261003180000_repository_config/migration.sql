ALTER TABLE "applications"
  ADD COLUMN "config_path" TEXT,
  ADD COLUMN "config_overrides" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "deployments"
  ADD COLUMN "resolved_plan" JSONB;
