-- AlterTable
ALTER TABLE "applications" ADD COLUMN     "auto_deploy" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "repo_full_name" TEXT;

-- AlterTable
ALTER TABLE "deployments" ADD COLUMN     "trigger" TEXT NOT NULL DEFAULT 'manual';

-- CreateTable
CREATE TABLE "github_apps" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "app_id" INTEGER NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "html_url" TEXT NOT NULL,
    "owner_login" TEXT,
    "credentials_encrypted" BYTEA NOT NULL,
    "installation_id" INTEGER,
    "installed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "github_apps_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "github_apps_organization_id_key" ON "github_apps"("organization_id");

-- CreateIndex
CREATE INDEX "github_apps_app_id_idx" ON "github_apps"("app_id");

-- CreateIndex
CREATE INDEX "applications_repo_full_name_idx" ON "applications"("repo_full_name");

-- AddForeignKey
ALTER TABLE "github_apps" ADD CONSTRAINT "github_apps_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
