-- CreateTable
CREATE TABLE "datastores" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "engine_version" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'provisioning',
    "memory_limit_mb" INTEGER,
    "cpu_limit" DOUBLE PRECISION,
    "storage_size_hint_bytes" BIGINT,
    "public_port" INTEGER,
    "credentials_encrypted" BYTEA NOT NULL,
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "datastores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "datastore_bindings" (
    "id" TEXT NOT NULL,
    "datastore_id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "env_keys" TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "datastore_bindings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "datastores_public_port_key" ON "datastores"("public_port");

-- CreateIndex
CREATE INDEX "datastores_organization_id_idx" ON "datastores"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "datastores_organization_id_slug_key" ON "datastores"("organization_id", "slug");

-- CreateIndex
CREATE INDEX "datastore_bindings_application_id_idx" ON "datastore_bindings"("application_id");

-- CreateIndex
CREATE UNIQUE INDEX "datastore_bindings_datastore_id_application_id_key" ON "datastore_bindings"("datastore_id", "application_id");

-- AddForeignKey
ALTER TABLE "datastores" ADD CONSTRAINT "datastores_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "datastore_bindings" ADD CONSTRAINT "datastore_bindings_datastore_id_fkey" FOREIGN KEY ("datastore_id") REFERENCES "datastores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "datastore_bindings" ADD CONSTRAINT "datastore_bindings_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

