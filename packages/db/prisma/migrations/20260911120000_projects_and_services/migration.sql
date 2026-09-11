-- Phase 9: one repository/commit can now produce a coordinated release of
-- routed HTTP services, private workers, and a one-shot release job. Existing
-- application/deployment rows remain unchanged and continue using their
-- original single-application path.
CREATE TABLE "projects" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "git_repository" TEXT NOT NULL,
  "git_branch" TEXT NOT NULL DEFAULT 'main',
  "repo_full_name" TEXT,
  "auto_deploy" BOOLEAN NOT NULL DEFAULT false,
  "status" TEXT NOT NULL DEFAULT 'idle',
  "env_vars_encrypted" BYTEA,
  "current_release_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "services" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "build_mode" TEXT NOT NULL DEFAULT 'dockerfile',
  "build_command" TEXT,
  "start_command" TEXT,
  "runtime_command" TEXT,
  "service_directory" TEXT NOT NULL DEFAULT '.',
  "workspace_selector" TEXT,
  "dockerfile_path" TEXT NOT NULL DEFAULT 'Dockerfile',
  "docker_target" TEXT,
  "image_group" TEXT,
  "port" INTEGER,
  "env_vars_encrypted" BYTEA,
  "build_args_encrypted" BYTEA,
  "memory_limit_mb" INTEGER,
  "cpu_limit" DOUBLE PRECISION,
  "restart_policy" TEXT NOT NULL DEFAULT 'unless-stopped',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "services_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "service_domains" (
  "id" TEXT NOT NULL,
  "service_id" TEXT NOT NULL,
  "hostname" TEXT NOT NULL,
  "is_primary" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "service_domains_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "project_releases" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "commit_sha" TEXT,
  "commit_message" TEXT,
  "trigger" TEXT NOT NULL DEFAULT 'manual',
  "source_release_id" TEXT,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "error_message" TEXT,
  "started_at" TIMESTAMP(3),
  "finished_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "project_releases_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "service_deployments" (
  "id" TEXT NOT NULL,
  "release_id" TEXT NOT NULL,
  "service_id" TEXT NOT NULL,
  "image_tag" TEXT,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "build_logs" TEXT,
  "error_message" TEXT,
  "exit_code" INTEGER,
  "container_id" TEXT,
  "started_at" TIMESTAMP(3),
  "finished_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "service_deployments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "service_logs" (
  "id" BIGSERIAL NOT NULL,
  "project_id" TEXT NOT NULL,
  "service_id" TEXT NOT NULL,
  "release_id" TEXT NOT NULL,
  "service_deployment_id" TEXT NOT NULL,
  "stream" TEXT NOT NULL,
  "level" TEXT NOT NULL DEFAULT 'info',
  "message" TEXT NOT NULL,
  "event_key" TEXT,
  "container_id" TEXT,
  "container_timestamp" TIMESTAMP(3),
  "container_timestamp_raw" TEXT,
  "restart_number" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "service_logs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "project_datastore_bindings" (
  "id" TEXT NOT NULL,
  "datastore_id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "env_key" TEXT NOT NULL,
  "service_ids" TEXT[] NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "project_datastore_bindings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "projects_organization_id_slug_key" ON "projects"("organization_id", "slug");
CREATE UNIQUE INDEX "projects_current_release_id_key" ON "projects"("current_release_id");
CREATE INDEX "projects_repo_full_name_idx" ON "projects"("repo_full_name");
CREATE UNIQUE INDEX "services_project_id_slug_key" ON "services"("project_id", "slug");
CREATE INDEX "services_project_id_kind_idx" ON "services"("project_id", "kind");
CREATE UNIQUE INDEX "services_one_release_per_project" ON "services"("project_id") WHERE "kind" = 'release';
CREATE UNIQUE INDEX "service_domains_hostname_key" ON "service_domains"("hostname");
CREATE INDEX "service_domains_service_id_idx" ON "service_domains"("service_id");
CREATE INDEX "project_releases_project_id_created_at_idx" ON "project_releases"("project_id", "created_at");
CREATE UNIQUE INDEX "service_deployments_release_id_service_id_key" ON "service_deployments"("release_id", "service_id");
CREATE INDEX "service_deployments_service_id_created_at_idx" ON "service_deployments"("service_id", "created_at");
CREATE INDEX "service_logs_project_id_id_idx" ON "service_logs"("project_id", "id");
CREATE INDEX "service_logs_service_id_id_idx" ON "service_logs"("service_id", "id");
CREATE INDEX "service_logs_release_id_id_idx" ON "service_logs"("release_id", "id");
CREATE UNIQUE INDEX "service_logs_event_key_key" ON "service_logs"("event_key");
CREATE UNIQUE INDEX "project_datastore_bindings_datastore_id_project_id_key" ON "project_datastore_bindings"("datastore_id", "project_id");
CREATE INDEX "project_datastore_bindings_project_id_idx" ON "project_datastore_bindings"("project_id");

ALTER TABLE "projects" ADD CONSTRAINT "projects_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "projects" ADD CONSTRAINT "projects_current_release_id_fkey" FOREIGN KEY ("current_release_id") REFERENCES "project_releases"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "services" ADD CONSTRAINT "services_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "service_domains" ADD CONSTRAINT "service_domains_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "services"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "project_releases" ADD CONSTRAINT "project_releases_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "project_releases" ADD CONSTRAINT "project_releases_source_release_id_fkey" FOREIGN KEY ("source_release_id") REFERENCES "project_releases"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "service_deployments" ADD CONSTRAINT "service_deployments_release_id_fkey" FOREIGN KEY ("release_id") REFERENCES "project_releases"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "service_deployments" ADD CONSTRAINT "service_deployments_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "services"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "service_logs" ADD CONSTRAINT "service_logs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "service_logs" ADD CONSTRAINT "service_logs_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "services"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "service_logs" ADD CONSTRAINT "service_logs_release_id_fkey" FOREIGN KEY ("release_id") REFERENCES "project_releases"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "service_logs" ADD CONSTRAINT "service_logs_service_deployment_id_fkey" FOREIGN KEY ("service_deployment_id") REFERENCES "service_deployments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "project_datastore_bindings" ADD CONSTRAINT "project_datastore_bindings_datastore_id_fkey" FOREIGN KEY ("datastore_id") REFERENCES "datastores"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "project_datastore_bindings" ADD CONSTRAINT "project_datastore_bindings_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
