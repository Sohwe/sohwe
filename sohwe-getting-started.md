# Sohwe — Getting Started & Architecture Guide

An open-source, self-hostable deployment platform — a spiritual cousin to Coolify / Dokploy / Railway that you run on your own servers. Git-push deploys, automatic HTTPS, live logs, custom domains, stateful apps.

Licensed **AGPL-3.0** (open-core friendly, prevents closed-source forks).

---

## Table of Contents

1. [Vision & Scope](#vision--scope)
2. [Phased Roadmap (High Level)](#phased-roadmap-high-level)
3. [Architecture Overview](#architecture-overview)
4. [Tech Stack & Decisions](#tech-stack--decisions)
5. [Prerequisites](#prerequisites)
6. [Phase 0 — Foundation](#phase-0--foundation)
7. [Phase 1 — First Deploy](#phase-1--first-deploy)
8. [Phase 2 — Broad Runtime Support](#phase-2--broad-runtime-support)
9. [Phase 3 — Stateful Apps](#phase-3--stateful-apps)
10. [Phase 4 — Observability](#phase-4--observability)
11. [Phase 4.5 — Portable Bundles](#phase-45--portable-bundles)
12. [Phase 5 — Git-Push Deploys](#phase-5--git-push-deploys)
13. [Phase 6 — Multi-User](#phase-6--multi-user)
14. [Cross-Cutting Concerns](#cross-cutting-concerns)
15. [Development Workflow](#development-workflow)
16. [Troubleshooting](#troubleshooting)
17. [Resources](#resources)

---

## Vision & Scope

Sohwe lets you:

- Connect a Git repo → it builds and runs it as a container with HTTPS and a URL.
- Deploy any runtime (Next.js, Node, Python, Go, Rust, static sites, arbitrary Docker images).
- Keep data via persistent volumes.
- Stream build and runtime logs, view CPU/memory, get alerts on crashes.
- Scale from single-server to multi-node when you need it.

### In scope for v1

- Single-server deployment
- Deploy apps from Git repos (manual button + push-to-deploy)
- Dockerfile builds and Nixpacks auto-detection
- Free wildcard subdomain (`*.sohwe.yourdomain.com`) + custom domains
- Automatic HTTPS via Let's Encrypt
- Persistent volumes (simple, one mount per path)
- Encrypted environment variables
- Live log tail + build logs + basic CPU/memory
- Single owner user at setup, invitable members afterwards

### Explicitly deferred to v2+

- Databases-as-a-service (one-click Postgres/Redis)
- Multi-node / cluster scheduling
- Preview deployments per pull request
- Log history beyond basic storage
- Prometheus / Grafana / Loki integration
- Billing / hosted SaaS version
- Full teams/orgs with fine-grained permissions

---

## Phased Roadmap (High Level)

| Phase | Goal | Rough time |
| --- | --- | --- |
| **0. Foundation** | Monorepo, DB schema, auth, empty dashboard | 1 week |
| **1. First Deploy** | Clone repo → Docker build → run container → public URL | 1–2 weeks |
| **2. Broad Runtimes** | Nixpacks, custom commands, custom domains | 1 week |
| **3. Stateful Apps** | Volumes, encrypted env vars, resource limits | 1 week |
| **4. Observability** | Live logs, build logs, CPU/mem, basic alerts | 2 weeks |
| **4.5. Portable Bundles** | Config export/restore, S3-compatible destinations, scheduled exports | 1 week |
| **5. Git-Push Deploys** | GitHub App, webhooks, auto-deploy | 1 week |
| **6. Multi-User** | Invites, roles, org scoping UI | 1 week |

Total: roughly 2 months of focused side-project effort to a public-beta-worthy v1.

---

## Architecture Overview

### Services

```
                      ┌──────────────────────┐
                      │       Dashboard       │  (Vite + React SPA, port 3000)
                      │                       │
                      └──────────┬────────────┘
                                 │ REST + SSE
                                 ▼
                      ┌──────────────────────┐
                      │         API           │  (Fastify, port 3001)
                      │  - Auth               │
                      │  - CRUD               │
                      │  - Enqueue jobs       │
                      │  - SSE log streams    │
                      └────┬──────────────┬───┘
                           │              │
                     reads │              │ enqueues
                           ▼              ▼
                      ┌─────────┐   ┌───────────┐
                      │Postgres │   │   Redis   │
                      └────▲────┘   └─────▲─────┘
                           │              │
                           │  reads       │ consumes
                           │              │
                      ┌────┴──────────────┴───┐
                      │       Worker          │  (BullMQ consumer)
                      │  - Git clone          │
                      │  - Build (Docker/Nix) │
                      │  - Run container      │
                      │  - Stream logs        │
                      └──────────┬────────────┘
                                 │ dockerode
                                 ▼
                      ┌──────────────────────┐
                      │     Docker engine     │
                      │                       │
                      │  ┌─────┐  ┌─────┐    │
                      │  │app-a│  │app-b│... │   (Traefik-labelled containers)
                      │  └─────┘  └─────┘    │
                      └──────────┬────────────┘
                                 │
                      ┌──────────▼────────────┐
                      │       Traefik         │  (80/443, auto-HTTPS)
                      │  Auto-discovers apps  │
                      │  via Docker labels    │
                      └───────────────────────┘
```

### Monorepo Layout

```
sohwe/
├── apps/
│   ├── api/                # Fastify API
│   ├── worker/             # BullMQ consumer
│   └── dashboard/          # Vite + React SPA
├── packages/
│   ├── db/                 # Prisma schema + client (shared)
│   ├── types/              # Shared TS types / Zod schemas
│   ├── queue/              # BullMQ job definitions (shared)
│   └── builder/            # Git clone + Nixpacks/Docker build logic
├── docker/
│   ├── api.Dockerfile
│   ├── worker.Dockerfile
│   └── dashboard.Dockerfile
├── docker-compose.dev.yml
├── docker-compose.prod.yml
├── package.json
├── pnpm-workspace.yaml
├── turbo.json
└── tsconfig.base.json
```

### Key Data Flow: Deploying an App

1. User clicks **Deploy** in the dashboard.
2. Dashboard calls `POST /api/applications/:id/deploy` on the API.
3. API creates a `Deployment` row (`status: pending`), enqueues a `deploy` job in BullMQ, returns 202.
4. Dashboard opens an SSE connection to `/api/deployments/:id/logs` to stream output.
5. Worker picks up the job, clones the repo, runs Nixpacks or `docker build`, tags the image.
6. Worker stops the old container (if any), starts the new one with Traefik labels.
7. Worker updates `Deployment.status` as it goes; each log line is emitted via Redis pub/sub → SSE → dashboard.
8. Traefik auto-discovers the new container and routes `myapp.sohwe.example.com` to it with HTTPS.

---

## Tech Stack & Decisions

| Layer | Choice | Why |
| --- | --- | --- |
| **Package manager** | pnpm + workspaces | Fast, disk-efficient, first-class monorepo support |
| **Build orchestrator** | Turborepo | Parallel `dev`/`build`, dep-aware caching |
| **Language** | TypeScript everywhere | Shared types between API / worker / dashboard |
| **API** | Fastify | Faster than Express, built-in schema validation, native streaming, pino logger |
| **DB** | PostgreSQL 16 | Prod-grade from day one; SQLite would hurt later |
| **ORM** | Prisma | Type-safe, great DX, migration tooling |
| **Queue** | BullMQ + Redis | Standard for Node job queues, good ergonomics |
| **Worker** | Separate Node service | Isolation; OSS users expect it; scales independently |
| **Dashboard** | Vite + React + TanStack Query + TanStack Router | Pure SPA, fast HMR, no SSR complexity for an internal tool |
| **Validation** | Zod + `fastify-type-provider-zod` | One schema, one source of truth, shared with frontend |
| **Auth** | better-auth (or Lucia) + Argon2 | Don't roll your own sessions |
| **Reverse proxy** | Traefik v3 | Auto-discovers containers via Docker labels, Let's Encrypt built in |
| **Build engine** | Nixpacks (primary), user Dockerfile (override) | Auto-detects Next.js/Node/Python/Go/Rust/static |
| **Container control** | dockerode (Node Docker SDK) | Direct Docker Engine API access |
| **Log streaming** | Server-Sent Events + Redis pub/sub | Simpler than WebSockets for one-way streams |
| **Secrets** | AES-256-GCM with `SOHWE_ENCRYPTION_KEY` | Env vars encrypted at rest |

### Rejected options (for the record)

- **Express** — fine, but streaming logs and schema validation are first-class in Fastify.
- **Next.js dashboard** — overkill for a pure SPA; SSR would actually complicate log streaming.
- **Caddy** — simpler than Traefik but requires regenerating the Caddyfile on every deploy; Traefik's label-based Docker provider is a better fit for a dynamic platform.
- **SQLite for v1** — tempting but painful when multi-node comes up.
- **Buildpacks (Paketo/Heroku)** — more battle-tested than Nixpacks but heavier and slower.

---

## Prerequisites

- **WSL2 with Ubuntu** (strongly recommended on Windows — Docker, dockerode, Nixpacks, Traefik labels, and Unix sockets are all smoother on Linux)
- **Docker Desktop** (with WSL2 backend enabled) or Docker Engine inside WSL
- **Node.js 24 LTS** (inside WSL) — current Active LTS, supported through April 2028
- **pnpm 9+** — install with `npm install -g pnpm`
- **Git**
- A code editor with the **WSL / Remote extension** (VS Code or Cursor)

### Why Node 24?

Node 24 "Krypton" is the current Active LTS (since October 2025). Relevant wins for Sohwe:

- Native TypeScript type-stripping is unflagged for `.ts` files (optional alternative to `tsx` in dev)
- Built-in `--env-file` flag — `dotenv` is no longer strictly required
- Stable `node --run`, stable test runner, stable permission model
- Built-in WebSocket client
- Newer V8 with solid streaming perf improvements

### Windows-specific setup

Open PowerShell as Administrator and install WSL2:

```powershell
wsl --install -d Ubuntu
```

Then from Ubuntu:

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs git
npm install -g pnpm
```

Open the project folder in your editor via the WSL connection (in VS Code / Cursor: `Ctrl+Shift+P` → "WSL: Open Folder in WSL"). From here on, **run every command inside WSL**, not PowerShell.

---

## Phase 0 — Foundation

Goal: end this phase with a running empty dashboard, a Fastify API with first-run setup + login, a Postgres database with the full schema, Redis, and Traefik — all in Docker Compose.

### 0.1 Create the Monorepo

```bash
mkdir sohwe && cd sohwe
git init
echo "node_modules/" > .gitignore
echo ".env" >> .gitignore
echo "dist/" >> .gitignore
echo ".turbo/" >> .gitignore

echo "24" > .nvmrc

pnpm init
```

Create `pnpm-workspace.yaml`:

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

Replace the generated `package.json` with:

```json
{
  "name": "sohwe",
  "version": "0.0.0",
  "private": true,
  "scripts": {
    "dev": "turbo run dev",
    "build": "turbo run build",
    "lint": "turbo run lint",
    "typecheck": "turbo run typecheck",
    "db:push": "pnpm --filter @sohwe/db exec prisma db push",
    "db:studio": "pnpm --filter @sohwe/db exec prisma studio",
    "db:generate": "pnpm --filter @sohwe/db exec prisma generate"
  },
  "devDependencies": {
    "turbo": "^2.0.0",
    "typescript": "^5.5.0"
  },
  "packageManager": "pnpm@9.0.0",
  "engines": {
    "node": ">=24"
  }
}
```

Create `turbo.json`:

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "dev": { "cache": false, "persistent": true },
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**"] },
    "lint": {},
    "typecheck": { "dependsOn": ["^build"] }
  }
}
```

Create `tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noUncheckedIndexedAccess": true
  }
}
```

Create the folder skeleton:

```bash
mkdir -p apps/api/src apps/worker/src apps/dashboard/src
mkdir -p packages/db/prisma packages/db/src packages/types/src packages/queue/src
mkdir -p docker
```

### 0.2 The `@sohwe/db` Package

`packages/db/package.json`:

```json
{
  "name": "@sohwe/db",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": {
    "generate": "prisma generate"
  },
  "dependencies": {
    "@prisma/client": "^5.17.0"
  },
  "devDependencies": {
    "prisma": "^5.17.0"
  }
}
```

`packages/db/prisma/schema.prisma` — the full multi-tenant schema from day one:

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model Organization {
  id           String        @id @default(uuid())
  name         String
  slug         String        @unique
  createdAt    DateTime      @default(now()) @map("created_at")
  users        User[]
  applications Application[]

  @@map("organizations")
}

model User {
  id             String       @id @default(uuid())
  email          String       @unique
  passwordHash   String       @map("password_hash")
  name           String?
  role           String       @default("owner") // owner | admin | member
  organizationId String       @map("organization_id")
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  createdAt      DateTime     @default(now()) @map("created_at")
  sessions       Session[]

  @@map("users")
}

model Session {
  id        String   @id @default(uuid())
  userId    String   @map("user_id")
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  expiresAt DateTime @map("expires_at")
  createdAt DateTime @default(now()) @map("created_at")

  @@map("sessions")
}

model Application {
  id                String       @id @default(uuid())
  organizationId    String       @map("organization_id")
  organization      Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  name              String
  slug              String
  gitRepo           String       @map("git_repository")
  gitBranch         String       @default("main") @map("git_branch")
  buildMode         String       @default("auto") @map("build_mode") // auto | dockerfile | nixpacks
  buildCmd          String?      @map("build_command")
  startCmd          String?      @map("start_command")
  port              Int          @default(3000)
  domain            String?
  envVarsEncrypted  Bytes?       @map("env_vars_encrypted")
  memoryLimitMb     Int?         @map("memory_limit_mb")
  cpuLimit          Float?       @map("cpu_limit")
  status            String       @default("idle") // idle | deploying | running | crashed | stopped
  createdAt         DateTime     @default(now()) @map("created_at")
  updatedAt         DateTime     @updatedAt @map("updated_at")
  deployments       Deployment[]
  volumes           Volume[]

  @@unique([organizationId, slug])
  @@map("applications")
}

model Deployment {
  id            String      @id @default(uuid())
  applicationId String      @map("application_id")
  application   Application @relation(fields: [applicationId], references: [id], onDelete: Cascade)
  commitSha     String?     @map("commit_sha")
  imageTag      String?     @map("image_tag")
  status        String      @default("pending") // pending | building | running | success | failed | cancelled
  buildLogs     String?     @map("build_logs") @db.Text
  errorMessage  String?     @map("error_message") @db.Text
  startedAt     DateTime?   @map("started_at")
  finishedAt    DateTime?   @map("finished_at")
  createdAt     DateTime    @default(now()) @map("created_at")

  @@index([applicationId, createdAt])
  @@map("deployments")
}

model Volume {
  id            String      @id @default(uuid())
  applicationId String      @map("application_id")
  application   Application @relation(fields: [applicationId], references: [id], onDelete: Cascade)
  mountPath     String      @map("mount_path")
  sizeBytes     BigInt?     @map("size_bytes")
  createdAt     DateTime    @default(now()) @map("created_at")

  @@unique([applicationId, mountPath])
  @@map("volumes")
}
```

`packages/db/src/index.ts`:

```typescript
import { PrismaClient } from "@prisma/client";

declare global {
  var __prisma: PrismaClient | undefined;
}

export const prisma =
  globalThis.__prisma ?? new PrismaClient({ log: ["warn", "error"] });

if (process.env.NODE_ENV !== "production") {
  globalThis.__prisma = prisma;
}

export * from "@prisma/client";
```

### 0.3 The `@sohwe/types` Package

`packages/types/package.json`:

```json
{
  "name": "@sohwe/types",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "dependencies": {
    "zod": "^3.23.0"
  }
}
```

`packages/types/src/index.ts`:

```typescript
import { z } from "zod";

export const FirstRunSetupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(1),
  organizationName: z.string().min(1)
});
export type FirstRunSetupInput = z.infer<typeof FirstRunSetupSchema>;

export const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1)
});
export type LoginInput = z.infer<typeof LoginSchema>;

export const CreateApplicationSchema = z.object({
  name: z.string().min(1),
  slug: z.string().regex(/^[a-z0-9-]+$/),
  gitRepo: z.string().url(),
  gitBranch: z.string().default("main"),
  port: z.number().int().min(1).max(65535).default(3000),
  buildMode: z.enum(["auto", "dockerfile", "nixpacks"]).default("auto"),
  buildCmd: z.string().optional(),
  startCmd: z.string().optional(),
  domain: z.string().optional()
});
export type CreateApplicationInput = z.infer<typeof CreateApplicationSchema>;
```

### 0.4 The `@sohwe/api` App

`apps/api/package.json`:

```json
{
  "name": "@sohwe/api",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@sohwe/db": "workspace:*",
    "@sohwe/types": "workspace:*",
    "@fastify/cookie": "^9.3.0",
    "@fastify/cors": "^9.0.0",
    "@fastify/sensible": "^5.6.0",
    "argon2": "^0.40.0",
    "bullmq": "^5.8.0",
    "dockerode": "^4.0.2",
    "dotenv": "^16.4.0",
    "fastify": "^4.28.0",
    "fastify-type-provider-zod": "^2.0.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/dockerode": "^3.3.29",
    "@types/node": "^24.0.0",
    "tsx": "^4.15.0",
    "typescript": "^5.5.0"
  },
  "engines": {
    "node": ">=24"
  }
}
```

`apps/api/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "module": "ESNext",
    "moduleResolution": "Bundler"
  },
  "include": ["src/**/*"]
}
```

`apps/api/.env`:

```bash
DATABASE_URL="postgresql://sohwe:password@localhost:5432/sohwe_dev"
REDIS_URL="redis://localhost:6379"
PORT=3001
NODE_ENV=development
SESSION_SECRET="change-me-to-a-long-random-string"
SOHWE_ENCRYPTION_KEY="change-me-to-a-32-byte-base64-string"
```

Generate a real encryption key:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

`apps/api/src/index.ts` — minimal Fastify server with first-run setup and login:

```typescript
import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import sensible from "@fastify/sensible";
import {
  serializerCompiler,
  validatorCompiler,
  ZodTypeProvider
} from "fastify-type-provider-zod";
import argon2 from "argon2";
import { prisma } from "@sohwe/db";
import {
  FirstRunSetupSchema,
  LoginSchema
} from "@sohwe/types";

const app = Fastify({ logger: true }).withTypeProvider<ZodTypeProvider>();
app.setValidatorCompiler(validatorCompiler);
app.setSerializerCompiler(serializerCompiler);

await app.register(cors, {
  origin: "http://localhost:3000",
  credentials: true
});
await app.register(cookie, { secret: process.env.SESSION_SECRET });
await app.register(sensible);

app.get("/health", async () => ({
  status: "ok",
  timestamp: new Date().toISOString()
}));

app.get("/api/setup/status", async () => {
  const userCount = await prisma.user.count();
  return { needsSetup: userCount === 0 };
});

app.post(
  "/api/setup",
  { schema: { body: FirstRunSetupSchema } },
  async (req, reply) => {
    const userCount = await prisma.user.count();
    if (userCount > 0) {
      return reply.conflict("Setup has already been completed");
    }

    const { email, password, name, organizationName } = req.body;
    const passwordHash = await argon2.hash(password);

    const org = await prisma.organization.create({
      data: {
        name: organizationName,
        slug: organizationName.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
        users: {
          create: {
            email,
            name,
            passwordHash,
            role: "owner"
          }
        }
      },
      include: { users: true }
    });

    return { ok: true, organizationId: org.id };
  }
);

app.post(
  "/api/auth/login",
  { schema: { body: LoginSchema } },
  async (req, reply) => {
    const { email, password } = req.body;
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return reply.unauthorized("Invalid credentials");

    const valid = await argon2.verify(user.passwordHash, password);
    if (!valid) return reply.unauthorized("Invalid credentials");

    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const session = await prisma.session.create({
      data: { userId: user.id, expiresAt }
    });

    reply.setCookie("sohwe_session", session.id, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      expires: expiresAt
    });

    return { id: user.id, email: user.email, name: user.name };
  }
);

app.post("/api/auth/logout", async (req, reply) => {
  const sessionId = req.cookies.sohwe_session;
  if (sessionId) {
    await prisma.session.deleteMany({ where: { id: sessionId } }).catch(() => {});
  }
  reply.clearCookie("sohwe_session", { path: "/" });
  return { ok: true };
});

app.get("/api/me", async (req, reply) => {
  const sessionId = req.cookies.sohwe_session;
  if (!sessionId) return reply.unauthorized();

  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    include: { user: { include: { organization: true } } }
  });
  if (!session || session.expiresAt < new Date()) {
    return reply.unauthorized();
  }

  return {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name,
    role: session.user.role,
    organization: {
      id: session.user.organization.id,
      name: session.user.organization.name
    }
  };
});

const port = Number(process.env.PORT ?? 3001);
await app.listen({ port, host: "0.0.0.0" });

process.on("SIGTERM", async () => {
  await app.close();
  await prisma.$disconnect();
  process.exit(0);
});
```

### 0.5 The `@sohwe/dashboard` App (Vite + React)

From the repo root:

```bash
cd apps/dashboard
pnpm create vite . --template react-ts
pnpm add @tanstack/react-query @tanstack/react-router
pnpm add -D tailwindcss@^3 postcss autoprefixer
npx tailwindcss init -p
```

Rename the app name in `apps/dashboard/package.json` to `@sohwe/dashboard` and set the dev port:

```json
{
  "name": "@sohwe/dashboard",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite --port 3000",
    "build": "tsc -b && vite build",
    "preview": "vite preview"
  }
}
```

`apps/dashboard/tailwind.config.js`:

```js
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: { extend: {} },
  plugins: []
};
```

`apps/dashboard/src/index.css`:

```css
@tailwind base;
@tailwind components;
@tailwind utilities;
```

Create a simple API client that talks to the Fastify server (`apps/dashboard/src/lib/api.ts`):

```typescript
const BASE = "http://localhost:3001";

export async function api<T>(
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
    ...init
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message ?? res.statusText);
  }
  return res.json();
}
```

Replace `apps/dashboard/src/App.tsx` with a minimal setup-or-login flow. (Full routing and UI is iterated on through the phases — for Phase 0 a login screen and an empty dashboard page are enough.)

### 0.6 Docker Compose — Dev Services

Create `docker-compose.dev.yml` at the repo root:

```yaml
services:
  postgres:
    image: postgres:16-alpine
    container_name: sohwe-db-dev
    environment:
      POSTGRES_DB: sohwe_dev
      POSTGRES_USER: sohwe
      POSTGRES_PASSWORD: password
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U sohwe"]
      interval: 10s
      timeout: 5s
      retries: 5

  redis:
    image: redis:7-alpine
    container_name: sohwe-redis-dev
    ports:
      - "6379:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5

  traefik:
    image: traefik:v3.1
    container_name: sohwe-traefik-dev
    command:
      - --api.insecure=true
      - --providers.docker=true
      - --providers.docker.exposedbydefault=false
      - --entrypoints.web.address=:80
    ports:
      - "80:80"
      - "8080:8080"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
    networks:
      - sohwe_proxy

networks:
  sohwe_proxy:
    name: sohwe_proxy

volumes:
  postgres_data:
```

### 0.7 Boot It All

From the repo root:

```bash
pnpm install
docker compose -f docker-compose.dev.yml up -d
pnpm db:generate
pnpm db:push
pnpm dev
```

You should see Turborepo launch the API (`:3001`) and dashboard (`:3000`) in parallel. Visit `http://localhost:3000` — it should redirect you to the first-run setup screen. Create the owner account, then log in.

### Phase 0 Checklist

- [ ] Monorepo builds with `pnpm install` + `pnpm build`
- [ ] `docker compose` brings up Postgres + Redis + Traefik
- [ ] `/health` on the API returns `ok`
- [ ] First-run setup creates the owner + organization
- [ ] Login sets a session cookie and `/api/me` returns the user
- [ ] Dashboard loads the logged-in empty state

---

## Phase 1 — First Deploy

Goal: the user can paste a public Git repo URL that contains a Dockerfile, hit **Deploy**, and after a minute or so the app is live at a public URL with streaming build logs.

### Build Order

1. **`@sohwe/queue` package** — BullMQ job types, the `deploy` queue definition, shared by API (producer) and worker (consumer).
2. **`@sohwe/builder` package** — git clone into a temp dir, run `docker build`, tag the image as `sohwe/<app-slug>:<deployment-id>`.
3. **Worker service skeleton** — connects to Redis, consumes `deploy` jobs, calls the builder, manages containers via `dockerode`.
4. **Container lifecycle** — stop-and-replace strategy for Phase 1 (no zero-downtime yet). Apply labels for Traefik:
   ```
   traefik.enable=true
   traefik.http.routers.<slug>.rule=Host(`<slug>.sohwe.localhost`)
   traefik.http.services.<slug>.loadbalancer.server.port=<port>
   sohwe.managed=true
   sohwe.app=<app-id>
   sohwe.deployment=<deployment-id>
   ```
5. **API endpoints**:
   - `POST /api/applications` — create app
   - `POST /api/applications/:id/deploy` — trigger deploy, enqueue job
   - `GET /api/deployments/:id/logs` (SSE) — stream build logs live via Redis pub/sub
   - `DELETE /api/applications/:id` — stop container, remove row
6. **Dashboard**:
   - Create-app form
   - App detail page with Deploy button and a live log panel (EventSource API)

### Key Design Decisions for Phase 1

- **Stop-then-start** container swap is fine for v1. Blue/green comes later.
- **Build context** is the cloned repo on disk. Nothing fancy — no layer caching across deploys in v1.
- **Log streaming**: worker appends each line to `deployment.buildLogs` **and** publishes to `logs:deployment:<id>` on Redis. The API's SSE handler subscribes to that channel and relays to the browser. On reconnect it replays the stored logs first.
- **Failure handling**: on build failure, mark deployment as `failed`, store stderr in `errorMessage`. Leave the previous running container untouched.

### Phase 1 Checklist

- [ ] Create an application via the dashboard
- [ ] Click Deploy, see live build logs
- [ ] App is reachable at `<slug>.sohwe.localhost` via Traefik
- [ ] Second deploy replaces the first container cleanly
- [ ] Deleting the app removes the container and DB row

---

## Phase 2 — Broad Runtime Support

Goal: users can deploy Next.js, Python, Go, Rust, static sites — without writing a Dockerfile.

- Integrate **Nixpacks** in the builder package. Run `nixpacks build <dir> --name <image>` when `buildMode === "auto"` and no Dockerfile exists.
- Add **build/start command overrides** in the app settings (optional; Nixpacks usually handles it).
- **Custom domains**: let user set `domain` on an app; update Traefik labels accordingly. Traefik handles Let's Encrypt automatically once you wire up the `certificatesresolvers` config.
- Configure production Traefik with ACME + persistent cert storage.

### Phase 2 Checklist

- [ ] Deploy a Next.js app from GitHub with no Dockerfile
- [ ] Deploy a Python (FastAPI) app with no Dockerfile
- [ ] Deploy a static Vite site with no Dockerfile
- [ ] Custom domain with automatic HTTPS works

---

## Phase 3 — Stateful Apps

Goal: apps can store data that survives redeploys.

- Add **persistent volumes**: one named Docker volume per `Volume` row, mounted at `mountPath` on container start. Volume name convention: `sohwe_app_<app-id>_<volume-id>`.
- **Encrypted env vars**: encrypt with AES-256-GCM using `SOHWE_ENCRYPTION_KEY`. Store ciphertext in `envVarsEncrypted`. Decrypt only when composing the `docker run` config.
- **Resource limits**: expose `memoryLimitMb` and `cpuLimit` on the app settings page; pass them to dockerode as `HostConfig.Memory` and `NanoCpus`.
- **Restart policy**: `unless-stopped` by default.

### Phase 3 Checklist

- [ ] Redeploy an app and verify data in its volume persists
- [ ] Env vars round-trip correctly and aren't readable as plaintext in the DB
- [ ] Setting a memory limit actually caps the container (verify with `docker stats`)

---

## Phase 4 — Observability

Goal: users can see what their apps are doing.

- **Runtime log tail**: worker attaches to `docker logs -f`, publishes to `logs:app:<id>` on Redis. API exposes `/api/applications/:id/logs` (SSE).
- **Log history**: keep the last ~10 MB per deployment in Postgres (or flat files on disk). Enough for v1; swap to Loki later.
- **Build logs**: already exist from Phase 1. Add a dedicated tab in the UI.
- **CPU / memory**: worker runs a lightweight `docker stats` stream per managed container, writes to Redis as `stats:app:<id>` with a 5s TTL. API exposes a lightweight polling or SSE endpoint.
- **Alerts**: watch for container `die` events via Docker events API. On crash, fire a webhook to a user-configured URL (Discord, Slack, generic).

### Phase 4 Checklist

- [ ] Live runtime logs visible in the dashboard
- [ ] Last-deploy build logs visible
- [ ] CPU / memory updating live per app
- [ ] Crash alert fires to a configured webhook

---

## Phase 4.5 — Portable Bundles

Goal: the owner can export everything that describes this instance's apps into a single, signed, encrypted archive, push it to S3 (or local disk), and restore it on a different Sohwe host with one command.

This is the v1 scope of §10.9 in the PRD — **config mode only**. Full-state backups (Postgres dump + volume contents + images) are Phase 5.5, post-GA.

### Concepts

A **bundle** is a zstd-compressed tar with this shape:

```
sohwe-<instance-id>-<timestamp>.tar.zst
├── manifest.json           # schema version, instance id, created_at, mode, file list + sha256
├── manifest.sig            # ed25519 signature over manifest.json
├── config/
│   ├── organization.json
│   ├── applications.json   # one entry per app: git repo, branch, build cfg, domain, limits
│   ├── volumes.json        # declared mount paths + size hints (no contents in config mode)
│   └── webhooks.json
├── secrets/
│   └── env.enc             # AES-256-GCM, key derived from passphrase via Argon2id
├── repos/                  # optional git mirrors (per-app opt-in)
│   └── <app-slug>.git.tar
└── README.md               # human-readable summary
```

Key rules:

- `manifest.json` is the source of truth. Restore refuses to start if any file's sha256 doesn't match.
- The source instance's **master key is never in the bundle**. Env vars are re-encrypted with a passphrase the user provides at export time.
- Bundles are **signed** with an ed25519 key held by the source instance; the public key is embedded in the manifest. Self-signed is fine — the signature proves the manifest wasn't tampered with in transit.

### Data Model Additions

Two new tables. Add to `packages/db/prisma/schema.prisma`:

```prisma
model BackupDestination {
  id              String   @id @default(uuid())
  organizationId  String   @map("organization_id")
  organization    Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  name            String
  kind            String   // local | s3
  configEncrypted Bytes    @map("config_encrypted") // endpoint, bucket, region, creds
  createdAt       DateTime @default(now()) @map("created_at")
  bundles         Bundle[]
  schedules       BackupSchedule[]

  @@map("backup_destinations")
}

model Bundle {
  id              String   @id @default(uuid())
  organizationId  String   @map("organization_id")
  mode            String   // config | full
  sizeBytes       BigInt   @map("size_bytes")
  checksum        String
  storageKey      String   @map("storage_key")
  destinationId   String?  @map("destination_id")
  destination     BackupDestination? @relation(fields: [destinationId], references: [id], onDelete: SetNull)
  createdAt       DateTime @default(now()) @map("created_at")

  @@index([organizationId, createdAt])
  @@map("bundles")
}

model BackupSchedule {
  id            String   @id @default(uuid())
  destinationId String   @map("destination_id")
  destination   BackupDestination @relation(fields: [destinationId], references: [id], onDelete: Cascade)
  cron          String   // e.g. "0 3 * * *"
  mode          String   @default("config")
  keepLast      Int?     @map("keep_last")
  keepDays      Int?     @map("keep_days")
  lastRunAt     DateTime? @map("last_run_at")
  enabled       Boolean  @default(true)
  createdAt     DateTime @default(now()) @map("created_at")

  @@map("backup_schedules")
}
```

Don't forget the back-reference on `Organization`:

```prisma
model Organization {
  // ... existing fields ...
  backupDestinations BackupDestination[]
  bundles            Bundle[]
}
```

### The `@sohwe/bundler` Package

Create a new workspace package: `packages/bundler/`. It owns bundle format, signing, crypto, and storage backends. Both the API (for UI-triggered exports) and a future `sohwe` CLI consume it.

```
packages/bundler/
├── package.json
├── src/
│   ├── index.ts
│   ├── manifest.ts        # schema, validation, hashing
│   ├── sign.ts            # ed25519 sign/verify
│   ├── crypto.ts          # passphrase → AES-256-GCM (Argon2id KDF)
│   ├── create.ts          # build a bundle from the DB
│   ├── restore.ts         # verify + apply a bundle to the DB
│   └── storage/
│       ├── index.ts       # Storage interface
│       ├── local.ts       # file:// backend
│       └── s3.ts          # @aws-sdk/client-s3, works for R2/B2/MinIO via endpoint override
```

Key dependencies:

```bash
pnpm --filter @sohwe/bundler add @aws-sdk/client-s3 @node-rs/argon2 tar zstd-napi
```

The `Storage` interface is tiny:

```typescript
export interface Storage {
  put(key: string, body: Readable, size: number): Promise<void>;
  get(key: string): Promise<Readable>;
  head(key: string): Promise<{ size: number; etag?: string }>;
  list(prefix: string): Promise<Array<{ key: string; size: number; lastModified: Date }>>;
  delete(key: string): Promise<void>;
}
```

### Passphrase-Derived Encryption

Never reuse the instance master key inside a bundle. Instead:

```typescript
import { hash } from "@node-rs/argon2";
import { createCipheriv, randomBytes } from "node:crypto";

export async function deriveBundleKey(passphrase: string, salt: Buffer) {
  const raw = await hash(passphrase, {
    salt,
    memoryCost: 65536,
    timeCost: 3,
    outputLen: 32,
    algorithm: 2 // Argon2id
  });
  return Buffer.from(raw, "utf8").subarray(0, 32);
}

export async function encryptEnvPayload(plaintext: string, passphrase: string) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await deriveBundleKey(passphrase, salt);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { salt, iv, tag: cipher.getAuthTag(), ciphertext: ct };
}
```

The salt + iv + tag go into `manifest.json` alongside the Argon2 parameters. On restore, the same parameters reproduce the key from the passphrase the user types.

### API Endpoints

Add to the Fastify API:

```
POST   /api/bundles                    # create a bundle (body: { mode, destinationId?, passphrase, includeRepos? })
GET    /api/bundles                    # list bundles (joins destinations)
GET    /api/bundles/:id                # manifest + metadata (no secret values)
GET    /api/bundles/:id/download       # stream bundle (local dest or presigned S3 URL)
POST   /api/bundles/restore            # body: { source: { destinationId, key } | upload, passphrase, conflict: "rename"|"overwrite"|"skip" }

POST   /api/backup-destinations        # create
GET    /api/backup-destinations        # list
DELETE /api/backup-destinations/:id

POST   /api/backup-schedules           # create
GET    /api/backup-schedules
PATCH  /api/backup-schedules/:id
DELETE /api/backup-schedules/:id
```

Bundle creation is a BullMQ job, not an inline request handler — it can take tens of seconds, especially with git mirrors enabled. Same pattern as deployments: enqueue, return 202 with a bundle id, stream progress via SSE on `/api/bundles/:id/logs`.

### Worker: Creating a Bundle

Job handler outline:

1. Mark `Bundle.status = creating` (extend the model with a `status` column or a sibling job record).
2. Open a streaming tar writer piped into a zstd encoder piped into the storage backend's `put()`.
3. Write `config/*.json` from Prisma queries (filter by `organizationId`).
4. **Decrypt** env-var ciphertexts with the instance master key, **re-encrypt** with the bundle passphrase, write to `secrets/env.enc`. Clear plaintext buffers immediately.
5. For each app with `includeRepo === true`, shell out to `git clone --mirror <repo> /tmp/<id>.git` then tar it into `repos/<app-slug>.git.tar`. Respect the tracked branch but clone all refs (branches + tags) — cheap insurance.
6. Compute sha256 of every entry as it streams, accumulate into `manifest.json`.
7. Write the manifest, sign it, write `manifest.sig`, close the archive.
8. Record final size + checksum in the `Bundle` row, mark `status = ready`.

Never write the plaintext bundle to local disk — streaming all the way to storage keeps secrets out of the host filesystem.

### Worker: Restoring a Bundle

Restore is safer as a two-step flow:

1. **Preflight**: download the manifest only, verify signature, verify schema compatibility, present a summary to the user (N apps, N domains, git mirrors present y/n, collision report). No writes.
2. **Apply**: user confirms, passes the passphrase, chooses conflict policy. Worker:
   - Streams the full bundle from storage.
   - Verifies every file's sha256 as it's extracted.
   - Derives the bundle key from the passphrase; decrypt env vars.
   - For each app in `applications.json`, check for slug collision in the target org and apply the conflict policy (`rename` appends `-restored-<date>`).
   - Re-encrypt env vars with the **target** instance's master key and write them to the new rows.
   - Leave domains in a `pending-dns` state until the operator explicitly activates them — don't trigger Let's Encrypt during restore.
   - Do **not** auto-deploy. Show a "Deploy all" button once the user is ready.

### Scheduled Exports

Reuse BullMQ's repeatable jobs:

```typescript
await deployQueue.add(
  "bundle:scheduled",
  { scheduleId },
  { repeat: { pattern: schedule.cron } }
);
```

A separate worker handler reads the schedule, creates a bundle with the destination's stored passphrase (encrypted with the instance master key — still not as good as a user passphrase, but acceptable for automated runs), uploads, applies the retention policy (delete bundles older than `keepDays` or beyond `keepLast`).

### S3-Compatible Storage

The AWS SDK v3 S3 client works transparently against R2, B2, MinIO, and Wasabi — pass a custom `endpoint` and `forcePathStyle: true`:

```typescript
import { S3Client } from "@aws-sdk/client-s3";

export function makeS3(config: S3Config) {
  return new S3Client({
    endpoint: config.endpoint,           // https://<account>.r2.cloudflarestorage.com
    region: config.region ?? "auto",
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey
    },
    forcePathStyle: config.forcePathStyle ?? true
  });
}
```

The destination UI only needs: name, endpoint (optional for real AWS), region, bucket, access key, secret key, force-path-style toggle.

### Dashboard

Three new pages under `Settings → Backups`:

- **Destinations**: CRUD for local + S3 destinations.
- **Bundles**: table of past bundles (size, mode, destination, created). Actions: Download, Restore from this, Delete.
- **Schedules**: cron editor with presets (Daily 3am / Weekly Sun / Custom), retention settings.

One prominent **Export now** button on the org Settings page that kicks off an ad-hoc bundle.

Restore has its own dedicated page with a two-step wizard (preflight summary → apply with passphrase).

### CLI (Thin Wrapper)

Even before a full `sohwe` CLI ships, a small helper is worth having:

```bash
# from the host running Sohwe
docker exec sohwe-api node scripts/bundle-create.js --mode config --out /backups/my.tar.zst --passphrase-file /run/secrets/bundle-pass
docker exec sohwe-api node scripts/bundle-restore.js --from /backups/my.tar.zst --passphrase-file /run/secrets/bundle-pass
```

These scripts just call into `@sohwe/bundler` directly. Ship them as part of the API image so the operator can always fall back to CLI when the dashboard is unavailable (e.g. restoring onto a fresh instance before any user exists).

### Phase 4.5 Checklist

- [ ] `BackupDestination`, `Bundle`, `BackupSchedule` tables migrated
- [ ] `@sohwe/bundler` package builds; local + S3 storage backends pass their unit tests
- [ ] Ad-hoc config bundle export works end-to-end (DB → tar.zst → storage)
- [ ] Manifest signing + sha256 verification on restore works; tampered bundles are rejected
- [ ] Passphrase-based env-var encryption round-trips correctly across two Sohwe instances
- [ ] Restore with `rename` / `overwrite` / `skip` conflict policy behaves correctly
- [ ] Domains after restore are flagged `pending-dns` and do **not** auto-request certs
- [ ] Scheduled daily bundle uploads to an S3 bucket and enforces retention
- [ ] Git mirror mode works for at least one private repo (clone back succeeds on target host)
- [ ] Bundle create/restore events appear in the audit log (once Phase 6 ships; wire the hooks now)
- [ ] Bundle operations never write plaintext secrets to disk or to any log stream

### Deferred to Phase 5.5

- Postgres dump and restore inside the bundle
- Raw volume tar + per-volume hooks (`pg_dump`, `mysqldump`, `redis-cli --rdb`)
- `docker save` of built images
- Incremental volume chunks (content-addressable storage)
- Restore drill (dry-run mode)

---

## Phase 5 — Git-Push Deploys

Goal: push to the tracked branch → it deploys.

- Create a **GitHub App** (not OAuth app). Needed for proper install flow, webhook signing, and per-repo permissions.
- Store app `installationId` per organization. Use the GitHub SDK to generate installation tokens on demand for cloning private repos.
- **Webhook handler** at `POST /api/webhooks/github`:
  - Verify signature with `X-Hub-Signature-256`.
  - On `push` to a tracked branch, enqueue a deploy job.
- Dashboard: repo picker that lists installation repos, "auto-deploy on push" toggle.

### Phase 5 Checklist

- [ ] GitHub App installed, repos listed
- [ ] `git push` triggers a deploy
- [ ] Private repos build successfully

---

## Phase 6 — Multi-User

Goal: the owner can invite teammates.

- **Invitations**: `Invitation` table (email, role, token, expiresAt). Send via email (Resend / Postmark / SMTP).
- **Roles**: `owner` / `admin` / `member`. Enforce in API with a `requireRole(...)` plugin.
- **Org switcher**: even though users currently belong to one org, ship the UI affordance — makes multi-org work trivial later.
- **Audit log**: record who did what (created app, deployed, deleted, rotated secret). Essential for any commercial product.

### Phase 6 Checklist

- [ ] Owner can invite a member by email
- [ ] Member can log in and see the org's apps
- [ ] Member cannot delete the org or change billing (future)

---

## Cross-Cutting Concerns

### Authentication

- Sessions stored server-side in `sessions` table. HttpOnly, SameSite=Lax cookie. No JWTs.
- Passwords hashed with **Argon2id**.
- Rate limit login with `@fastify/rate-limit` (5/min per IP).
- Consider adopting [`better-auth`](https://www.better-auth.com/) once you need OAuth / 2FA / passkeys — it plugs into your existing Prisma schema.

### Secrets Encryption

```typescript
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const key = Buffer.from(process.env.SOHWE_ENCRYPTION_KEY!, "base64");

export function encrypt(plaintext: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]);
}

export function decrypt(buf: Buffer): string {
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}
```

Rotate `SOHWE_ENCRYPTION_KEY` only via a migration script that re-encrypts all rows; never in place.

### Docker Labels & Networking

Every managed container gets:

```
sohwe.managed=true
sohwe.app=<app-id>
sohwe.deployment=<deployment-id>
traefik.enable=true
traefik.http.routers.<slug>.rule=Host(`<host>`)
traefik.http.routers.<slug>.entrypoints=websecure
traefik.http.routers.<slug>.tls.certresolver=letsencrypt
traefik.http.services.<slug>.loadbalancer.server.port=<internal-port>
```

Network strategy:

- `sohwe_proxy` — shared network that Traefik and every managed container attach to.
- `sohwe_app_<app-id>_net` — per-app internal network for sidecars/DB links (Phase 3+).

### GitHub App Setup

Documented in Phase 5 but the gist:

1. Register a GitHub App in your org.
2. Permissions: `Contents: read`, `Metadata: read`, `Webhooks: write`.
3. Webhook URL: `https://<your-sohwe-domain>/api/webhooks/github`.
4. Store the App ID, private key, and webhook secret in the Sohwe instance config.

---

## Development Workflow

### Useful Commands

```bash
pnpm dev                      # Start everything in parallel (api + worker + dashboard)
pnpm --filter @sohwe/api dev  # Start just the API
pnpm db:studio                # Prisma Studio at http://localhost:5555
pnpm db:push                  # Push schema changes to the dev DB (no migrations in dev)
pnpm typecheck                # Typecheck the whole monorepo
docker compose -f docker-compose.dev.yml logs -f  # Service logs
```

### Adding a Dependency to One Workspace

```bash
pnpm --filter @sohwe/api add some-package
pnpm --filter @sohwe/dashboard add -D some-dev-package
```

### Git Hygiene

- One commit per logical change.
- Migrations (`prisma migrate`) start being used the first time you deploy Sohwe somewhere real. Dev uses `db push`.
- Tag v0.1.0 at the end of Phase 1 so you can always roll back to "first working deploy".

---

## Troubleshooting

### `pnpm dev` says a workspace package isn't found

Run `pnpm install` from the repo root after creating new packages. pnpm doesn't auto-discover without an install pass.

### Prisma Client errors after schema change

```bash
pnpm db:generate
pnpm db:push
```

### Traefik returns 404 for a deployed app

- Is the container attached to the `sohwe_proxy` network?
- Does `traefik.http.routers.<slug>.rule` match the host you're visiting?
- Check Traefik's dashboard at `http://localhost:8080`.

### `argon2` install fails to build on Node 24

The native `argon2` package ships prebuilt binaries but occasionally lags a Node major. Two options:

1. Install build tools so it can compile from source:
   ```bash
   sudo apt-get install -y build-essential python3
   pnpm install --force
   ```
2. Swap to a prebuilt-everywhere alternative. In `apps/api/package.json` replace `argon2` with `@node-rs/argon2` (Rust + napi, same hashing algorithm, slightly different API) and update the import:
   ```typescript
   import { hash, verify } from "@node-rs/argon2";
   const passwordHash = await hash(password);
   const ok = await verify(user.passwordHash, password);
   ```

### Docker socket permission denied from WSL

Add your WSL user to the `docker` group:

```bash
sudo usermod -aG docker $USER
newgrp docker
```

### Port 3001 or 3000 already in use

```bash
ss -ltnp | grep -E '3000|3001'
kill <PID>
```

---

## Resources

- [Fastify docs](https://fastify.dev/docs/latest/) — start with Getting Started and the Plugins Guide
- [Prisma docs](https://www.prisma.io/docs)
- [BullMQ docs](https://docs.bullmq.io/)
- [Traefik v3 docs](https://doc.traefik.io/traefik/)
- [Nixpacks docs](https://nixpacks.com/docs)
- [dockerode](https://github.com/apocas/dockerode)
- [TanStack Router](https://tanstack.com/router) / [TanStack Query](https://tanstack.com/query)
- [Coolify](https://github.com/coollabsio/coolify) and [Dokploy](https://github.com/Dokploy/dokploy) — read their source for inspiration (both AGPL/MIT and worth studying)

---

## License

Sohwe is licensed under **AGPL-3.0**. That means anyone can run, modify, and redistribute it — but derivative hosted services must also open-source their changes. This protects the project from closed-source commercial forks while leaving room for an open-core hosted SaaS offering down the road.

---

Built for developers who want their own platform.
