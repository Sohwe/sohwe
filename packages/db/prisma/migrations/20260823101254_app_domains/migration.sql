-- Custom domains move from the single `applications.domain` column to their own
-- table, so an app can answer on several hostnames (apex + www, a vanity
-- domain, a cutover) and each can be verified independently.
--
-- Destructive: `applications.domain` is dropped. Every non-null value is
-- copied into `domains` as that app's primary domain first, so no configured
-- domain is lost. There is no down-migration.

-- CreateTable
CREATE TABLE "domains" (
    "id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "last_status" TEXT,
    "last_checked_at" TIMESTAMP(3),
    "verified_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "domains_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "domains_hostname_key" ON "domains"("hostname");

-- CreateIndex
CREATE INDEX "domains_application_id_idx" ON "domains"("application_id");

-- AddForeignKey
ALTER TABLE "domains" ADD CONSTRAINT "domains_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Carry existing custom domains over as primary domains. The old column had no
-- uniqueness constraint, so two apps could name the same host (which Traefik
-- could only ever route to one of them); `ON CONFLICT DO NOTHING` keeps the
-- oldest app's claim and drops the shadowed duplicate rather than failing the
-- migration.
INSERT INTO "domains" ("id", "application_id", "hostname", "is_primary", "created_at")
SELECT gen_random_uuid()::text, "id", lower("domain"), true, "created_at"
FROM "applications"
WHERE "domain" IS NOT NULL AND "domain" <> ''
ORDER BY "created_at" ASC
ON CONFLICT ("hostname") DO NOTHING;

-- AlterTable
ALTER TABLE "applications" DROP COLUMN "domain";
