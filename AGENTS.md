# Working in Sohwe

Sohwe is a pnpm 9/Turborepo monorepo using Node.js 24+. The API is Fastify, the dashboard is React/Vite, and the worker builds and runs apps through Docker. Read `README.md` for setup, `DEVELOPMENT.md` for local development, `UPCOMING_PLANS.md` for active plans, and `CHANGELOG.md` for release history. Check the code for current behavior.

## Workflow

- From the repo root, run `node scripts/dev-setup.mjs` for local setup, then `pnpm dev`.
- Run the narrowest relevant checks before handing off a change: `pnpm typecheck`, `pnpm lint`, `pnpm build`, and/or `pnpm test`. API route tests need a disposable `TEST_DATABASE_URL`; without it, that suite skips.
- Keep tests beside code under `src/`. Add new test files to the relevant package's `test` script.
- Never commit generated `.env` files or real secrets.

## Implementation boundaries

- Put API/dashboard shared schemas in `packages/types`. Import workspace code by package name, and keep TypeScript strictness intact.
- Register API routes through `buildServer` in `apps/api/src/server.ts`; keep `index.ts` for process startup. Scope protected queries by `req.user!.organizationId` and use `requireRole(min)` for role checks. Routes that can expose secrets require at least `admin`, including read routes.
- Keep encrypted variables, build arguments, GitHub credentials, invitation tokens, and backup passphrases out of API responses, logs, errors, and audit rows. Use the existing public serializers and redaction helpers. Do not log request bodies on variable mutation routes.
- Runtime variables and build variables are separate encrypted maps. The dashboard's combined variable list is a projection; keep merging logic in `apps/api/src/routes/variable-store.ts`.
- Custom domains live in the `Domain` table. The application's `domain` field is a projection of its primary domain, not another stored value. Domain changes take effect when the app deploys.
- The worker owns deployments and Docker operations. Keep build-mode behavior in `packages/builder`, container configuration in `apps/worker/src/container-spec.ts`, and resource names/channels in shared helpers rather than constructing them ad hoc.
- Verify GitHub webhook signatures against the raw request body before trusting the payload. Redact installation tokens from clone failures. Commit-status reporting must not fail a deploy.
- Portable bundles contain configuration, not volume data. A bundle format change needs a version bump and migration path; do not edit the frozen golden bundle test to make an incompatible change pass.

## Database and production

- Ship every committed schema change as a new Prisma migration. Review generated SQL for destructive changes; `sohwe rollback` does not reverse schema changes. Use `pnpm db:push` only for throwaway databases.
- Never edit released migrations or rename `20260722000000_init`: the upgrade baseline depends on that exact name. After schema changes, run `pnpm db:generate` and `pnpm typecheck`.
- Wire new API or worker environment variables through `scripts/install.sh` and `docker-compose.prod.yml` as well as local configuration.
- Update `README.md` and `CHANGELOG.md` when installer, host CLI, Docker, or production behavior changes. Keep `UPCOMING_PLANS.md` aligned with active work.

## Release versions

- Use semantic version tags. New features bump the minor version; bug fixes bump the patch version. Decide the version explicitly for breaking changes before tagging.
- Before a release tag, update the root package version, lockfile, and changelog to match the tag. Do not use a patch tag for a feature release.
