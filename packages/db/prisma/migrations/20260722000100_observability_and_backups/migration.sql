-- CreateTable
CREATE TABLE "alert_destinations" (
    "id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "alert_destinations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backup_destinations" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "secret_encrypted" BYTEA,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "backup_destinations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bundles" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "destination_id" TEXT,
    "schedule_id" TEXT,
    "filename" TEXT NOT NULL,
    "size_bytes" BIGINT,
    "app_count" INTEGER NOT NULL,
    "includes_secrets" BOOLEAN NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ready',
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bundles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backup_schedules" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "destination_id" TEXT NOT NULL,
    "cron" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "includes_secrets" BOOLEAN NOT NULL DEFAULT true,
    "passphrase_encrypted" BYTEA NOT NULL,
    "retention_count" INTEGER,
    "last_run_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "backup_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "alert_destinations_application_id_idx" ON "alert_destinations"("application_id");

-- CreateIndex
CREATE INDEX "backup_destinations_organization_id_idx" ON "backup_destinations"("organization_id");

-- CreateIndex
CREATE INDEX "bundles_organization_id_created_at_idx" ON "bundles"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "bundles_schedule_id_created_at_idx" ON "bundles"("schedule_id", "created_at");

-- CreateIndex
CREATE INDEX "backup_schedules_organization_id_idx" ON "backup_schedules"("organization_id");

-- AddForeignKey
ALTER TABLE "alert_destinations" ADD CONSTRAINT "alert_destinations_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "backup_destinations" ADD CONSTRAINT "backup_destinations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bundles" ADD CONSTRAINT "bundles_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bundles" ADD CONSTRAINT "bundles_destination_id_fkey" FOREIGN KEY ("destination_id") REFERENCES "backup_destinations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bundles" ADD CONSTRAINT "bundles_schedule_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "backup_schedules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "backup_schedules" ADD CONSTRAINT "backup_schedules_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "backup_schedules" ADD CONSTRAINT "backup_schedules_destination_id_fkey" FOREIGN KEY ("destination_id") REFERENCES "backup_destinations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

