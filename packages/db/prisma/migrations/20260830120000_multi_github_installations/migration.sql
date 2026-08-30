-- One instance-owned GitHub App can now be installed on multiple GitHub
-- accounts and organizations. Preserve the existing installation, if any, in
-- the new child table before removing the scalar columns.

ALTER TABLE "github_apps"
ADD COLUMN "multi_account" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "github_installations" (
    "id" TEXT NOT NULL,
    "github_app_id" TEXT NOT NULL,
    "installation_id" INTEGER NOT NULL,
    "account_login" TEXT,
    "account_type" TEXT,
    "repository_selection" TEXT,
    "html_url" TEXT,
    "installed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "github_installations_pkey" PRIMARY KEY ("id")
);

INSERT INTO "github_installations" (
    "id",
    "github_app_id",
    "installation_id",
    "installed_at",
    "updated_at"
)
SELECT
    "id" || ':' || "installation_id"::TEXT,
    "id",
    "installation_id",
    COALESCE("installed_at", CURRENT_TIMESTAMP),
    CURRENT_TIMESTAMP
FROM "github_apps"
WHERE "installation_id" IS NOT NULL;

CREATE UNIQUE INDEX "github_installations_installation_id_key"
ON "github_installations"("installation_id");

CREATE INDEX "github_installations_github_app_id_idx"
ON "github_installations"("github_app_id");

ALTER TABLE "github_installations"
ADD CONSTRAINT "github_installations_github_app_id_fkey"
FOREIGN KEY ("github_app_id") REFERENCES "github_apps"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "github_apps"
DROP COLUMN "installation_id",
DROP COLUMN "installed_at";
