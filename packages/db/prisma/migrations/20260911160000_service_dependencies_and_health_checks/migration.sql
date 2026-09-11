-- Service startup ordering and Docker-native readiness checks. This remains
-- additive and leaves legacy applications and existing project services on
-- the same two-second process-stability default.
ALTER TABLE "services"
  ADD COLUMN "health_check_command" TEXT,
  ADD COLUMN "health_check_interval_seconds" INTEGER NOT NULL DEFAULT 10,
  ADD COLUMN "health_check_timeout_seconds" INTEGER NOT NULL DEFAULT 5,
  ADD COLUMN "health_check_retries" INTEGER NOT NULL DEFAULT 3,
  ADD COLUMN "health_check_start_period_seconds" INTEGER NOT NULL DEFAULT 2;

CREATE TABLE "service_dependencies" (
  "service_id" TEXT NOT NULL,
  "dependency_service_id" TEXT NOT NULL,
  "condition" TEXT NOT NULL DEFAULT 'healthy',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "service_dependencies_pkey"
    PRIMARY KEY ("service_id", "dependency_service_id"),
  CONSTRAINT "service_dependencies_not_self"
    CHECK ("service_id" <> "dependency_service_id"),
  CONSTRAINT "service_dependencies_condition_check"
    CHECK ("condition" IN ('started', 'healthy'))
);

CREATE INDEX "service_dependencies_dependency_service_id_idx"
  ON "service_dependencies"("dependency_service_id");

ALTER TABLE "service_dependencies"
  ADD CONSTRAINT "service_dependencies_service_id_fkey"
  FOREIGN KEY ("service_id") REFERENCES "services"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "service_dependencies"
  ADD CONSTRAINT "service_dependencies_dependency_service_id_fkey"
  FOREIGN KEY ("dependency_service_id") REFERENCES "services"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
