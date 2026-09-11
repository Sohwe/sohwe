-- Phase 9 foundation: a repository remains the Docker build context while an
-- application may select a nested Dockerfile and/or one named multi-stage
-- target. Existing applications retain the root-Dockerfile behavior.
ALTER TABLE "applications"
  ADD COLUMN "dockerfile_path" TEXT NOT NULL DEFAULT 'Dockerfile',
  ADD COLUMN "docker_target" TEXT,
  ADD COLUMN "runtime_command" TEXT;
