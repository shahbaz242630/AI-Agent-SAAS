# Eva — AI Business Communications Platform

Modular, cloud-first AI communications SaaS for UK small businesses.
Governing documents:

- `Eva BRD v1.2 - Consolidated Build Specification.md` — full specification (source of truth)
- `PHASE-0-HANDOFF.md` — session onboarding, decisions and progress tracking
- `docs/PHASE-0-PLAN.md` — approved Phase 0 plan

## Stack

Next.js 16 · NestJS 11 · Inngest · PostgreSQL 16 (Supabase, London) · Prisma 7 ·
Supabase Auth · Paddle · TypeScript 5 strict · pnpm workspaces · Docker · Railway.

## Prerequisites

- Node.js 22 LTS (fnm/nvm auto-switches via `.nvmrc` / `.node-version`)
- pnpm 10 (`corepack enable && corepack prepare pnpm@10.15.0 --activate`)
- Docker (for the local Compose environment)

## Quickstart

```bash
pnpm install
pnpm build          # builds packages, then apps (topological order)
pnpm dev            # web :3000 · api :3001 · worker :3002
```

Local infrastructure (Postgres 16, containerised api + worker):

```bash
docker compose -f infrastructure/docker/docker-compose.yml up
```

## Verification

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

## Repository layout

`apps/web` (Next.js) · `apps/api` (NestJS) · `apps/worker` (Inngest) ·
`packages/*` (shared ui, design-system, types, validation, configuration, testing) ·
`infrastructure/*` (database, docker, ci, deployment)

## Rules of engagement

Development follows the BRD: small, tested, approval-gated slices (BRD Sections 3.2
and 19). Read `PHASE-0-HANDOFF.md` first in every new session.
