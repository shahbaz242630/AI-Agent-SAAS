# EVA — Phase 0 Pre-Code Plan (BRD Section 27 Deliverable)

**Status:** AWAITING USER APPROVAL — no code may be written until this plan is approved.
**Date:** 2026-07-21
**Author:** The Builder
**Governing docs:** `Eva BRD v1.2 - Consolidated Build Specification.md` · `PHASE-0-HANDOFF.md`

---

## 1. Proposed Repository Structure (BRD Section 8)

pnpm-workspace monorepo. Built exactly per BRD Section 8 — nothing more, no future-module scaffolding (Rule 11).

```text
AI-Agent-SAAS/
├── apps/
│   ├── web/                    # Next.js 16 (App Router) — responsive web app
│   ├── api/                    # NestJS 11 backend API
│   │   └── src/modules/        # business modules (Phase 0 creates only what Phase 0 needs)
│   └── worker/                 # Inngest function host (background jobs)
├── packages/
│   ├── ui/                     # shared UI components (shell only in Phase 0)
│   ├── design-system/          # Tailwind v4 theme tokens
│   ├── api-client/             # generated typed client (from OpenAPI spec)
│   ├── types/                  # shared TS types/contracts
│   ├── validation/             # shared zod schemas
│   ├── authentication/         # auth helpers
│   ├── entitlements/           # entitlement-check helpers
│   ├── configuration/          # shared env/config handling
│   └── testing/                # test utilities and factories
├── infrastructure/
│   ├── database/               # Prisma schema, migrations, seed
│   ├── docker/                 # Dockerfiles (api, worker), docker-compose.yml
│   ├── ci/                     # GitHub Actions workflows
│   └── deployment/             # environment config notes
├── docs/                       # plans, architecture notes (this file)
├── .env.example                # documented env vars, no secrets
├── .node-version / .nvmrc      # pins Node 22
├── pnpm-workspace.yaml
├── package.json                # root scripts + engines
├── tsconfig.base.json          # strict base config
└── README.md
```

Phase 0 creates **only** the modules Phase 0 needs inside `apps/api/src/modules/`: `organisations`, `users`, `authentication` support, `audit` (basic), `monitoring` (health). All other module folders (`invoices`, `email-credit-control`, voice, leads, receptionist, etc.) are created **only when their phase begins** — no empty folders, no stubs.

## 2. Stack Confirmation (BRD Section 9) + Hosting Decision

All Section 9 decisions confirmed as binding — no substitutions:

- **Frontend:** Next.js 16 (App Router) · React 19 · TypeScript 5 strict · Tailwind CSS v4 · shadcn/ui · react-hook-form + zod
- **Backend:** NestJS 11 (Express 5 adapter) · REST + OpenAPI (Swagger generated from code)
- **Background:** Inngest (durable functions); Trigger.dev pre-approved fallback
- **Database:** PostgreSQL 16+ on Supabase, London (eu-west-2) · Prisma 7 · app-layer scoping + RLS
- **Auth:** Supabase Auth (email/password + MFA) · HTTP-only secure cookies · NestJS JWT guard
- **Payments:** Paddle (MoR) · internal entitlement engine is source of truth
- **Voice (Phase 2):** Vapi + Twilio UK · **AI:** OpenAI structured outputs
- **Email:** Microsoft Graph (customer mailboxes) · Resend (transactional)
- **Monitoring:** Sentry · structured JSON logs with correlation IDs
- **CI/CD:** GitHub Actions · **Runtime:** Node.js 22 LTS · **Package manager:** pnpm
- **Environments:** dev (local Docker Compose) · staging · production

### Hosting decision (the one open Phase 0 choice)

**Railway.** Justification: Railway runs our two Docker services (`api`, `worker`) with usage-based pricing that is the cheapest fit at our scale (~$8–15/month early vs Render's ~$14/month floor), offers first-class monorepo and multi-environment (staging/production) support with the least operational overhead, and accepts standard Dockerfiles — so migration to Render or Fly.io later is low-cost if requirements change. Web frontend on Vercel free tier (or Railway if consolidation is preferred later).

## 3. Why This Stack Fits the Product

- **One language end-to-end** (BRD 3.7): shared types/validation between web, api and worker removes an entire class of integration bugs and keeps a small team fast.
- **Modular monolith (NestJS modules + pnpm packages):** matches the BRD's core requirement — modules independently enabled/tested/billed without premature microservice complexity.
- **Inngest:** durable, retryable, scheduled functions are exactly the reminder/send-queue/retry semantics the Email Credit Controller needs; no hand-rolled cron (prohibited) and no ops-heavy queue infra.
- **Supabase (London):** managed Postgres + Auth + Storage in one EU/UK-region project satisfies data-residency requirements and removes auth/database undifferentiated heavy lifting; RLS gives defence-in-depth tenant isolation.
- **Prisma 7:** type-safe data access with forward-only migrations and rollback notes per BRD.
- **Paddle MoR:** removes VAT/tax compliance burden for a UK microbusiness SaaS.
- **Docker + Railway:** identical artefacts locally, in CI and in production; boring, portable, cheap.

## 4. Module-Boundary Design

- Each business module lives in `apps/api/src/modules/<name>/` as a NestJS module with an explicit public surface: only its exported **service contract** may be imported by other modules (enforced by ESLint boundary rules — no deep imports into another module's internals).
- Cross-module shared contracts live **only** in `packages/types` and `packages/validation`.
- Provider access (Microsoft, Paddle, OpenAI, voice, WhatsApp) is confined to adapter implementations in `modules/integrations` behind the interfaces in BRD Section 11. Business logic never imports provider SDKs directly.
- Cross-module state changes flow through domain events (BRD Section 12) with idempotent handlers — no hidden direct mutation of another module's data.
- Invoice status will change only via a single state-machine service in the invoices module (Phase 1) — Phase 0 establishes the pattern, not the module.
- Frontend contains no business logic; it consumes `packages/api-client` only.

## 5. Database Approach (Prisma 7 + Supabase Postgres + RLS)

- **Schema location:** `infrastructure/database/prisma/schema.prisma`; migrations via Prisma Migrate, forward-only, each with a rollback note in its PR description.
- **Phase 0 schema (minimal):** `organisations`, `organisation_settings`, `users` (mirrors Supabase Auth identity), `organisation_memberships`, `roles`/`permissions` (basic role model), `audit_logs`. Nothing else — invoicing/CRM tables arrive in Phase 1.
- **Tenant isolation (two layers, both tested):**
  1. Application layer: a Prisma client extension/middleware that injects `organisation_id` scoping into every tenant-owned query; services cannot query cross-tenant by construction.
  2. Postgres RLS: every tenant-owned table gets `ENABLE ROW LEVEL SECURITY` + policies keyed to the request's organisation (set via `SET app.current_org` per transaction); direct-table access bypass tests included.
- **Conventions (BRD 10):** soft delete on business records; `created_at`/`updated_at`/`created_by`; money as integer minor units + currency code; all timestamps UTC.
- **Local dev:** PostgreSQL 16 container in Docker Compose for fast, disposable local/test databases; Supabase cloud project used for staging/production. Seed script creates a demo organisation with sample users/settings (BRD 18.6), clearly flagged, excluded from any real sending.

## 6. Testing Approach

Proposal (BRD names no test runner — flagged for approval, Rule 12):

- **Unit:** Vitest (fast, TS-native, works for both Next.js and NestJS code). Required coverage per BRD 13: due-date/timezone maths (later phases), state transitions, entitlement/permission checks, etc. Phase 0: role-permission checks, tenant-scoping logic, config validation.
- **API integration:** supertest against a test Postgres (Docker) — includes RLS cross-tenant access-attempt tests (BRD 13 security tests).
- **E2E:** Playwright — Phase 0 covers sign-up → create organisation → sign-in; later slices add the BRD 13 critical journeys.
- **Factories/fixtures:** `packages/testing` from day one.
- **External APIs:** always mocked in automated tests (BRD 13).
- **CI gate:** lint + typecheck + unit + build on every PR; tests must pass before merge (branch protection).

## 7. Monitoring Approach

- **Logs:** structured JSON via `nestjs-pino` (pino) with correlation IDs propagated per request/job; log fields per BRD 14 (no financial detail, no tokens).
- **Errors:** Sentry SDKs in `web`, `api`, `worker` (three DSNs); source maps in CI.
- **Health:** `GET /health` (liveness) + `GET /health/ready` (DB connectivity) on the api; uptime monitoring target.
- **Metrics baseline:** request duration, job latency, queue depth hooks from Phase 0 so BRD 14 metrics have somewhere to live as slices land.

## 8. Security Baseline

- Secrets only in platform env management (Railway/Supabase/GitHub Environments); `.env.example` committed, real `.env` gitignored; secret-scanning (gitleaks) in CI.
- Supabase JWT verification guard on every api route (except health); role checks behind a permissions guard — backend-enforced, never frontend-only (BRD 5).
- Tenant isolation: app-layer scoping + RLS (Section 5) with cross-tenant attack tests in CI.
- Security headers + locked-down CORS (helmet) on api; rate limiting on public endpoints.
- Dependency scanning: `pnpm audit` + Dependabot (or Renovate) in CI.
- Zod/class-validator validation on every inbound payload boundary.
- TLS everywhere (platform-provided); tokens encrypted at rest when they arrive (Phase 1).

## 9. Exact Scope of the First Feature Slice

**Slice 0.1 — Repository scaffold, tooling and health endpoint** (the only slice proposed for approval now):

- pnpm workspace + repository structure per Section 1 (Phase 0 subset only)
- TypeScript 5 strict base config, ESLint 9 flat config + Prettier, module-boundary lint rules
- `.nvmrc`/`.node-version` (Node 22), `package.json` engines, `.env.example`, `.gitignore` hardening
- NestJS `api` app with `GET /health` returning service/version/timestamp + structured JSON logging + correlation ID middleware
- Next.js `web` app shell (App Router, Tailwind v4, design-system package wired, one placeholder-free landing page)
- `worker` app skeleton hosting Inngest with ONE example durable function (BRD Phase 0 scope)
- Docker Compose (api, worker, postgres:16) + Dockerfiles for api and worker
- CI workflow: install, lint, typecheck, unit tests, build (GitHub Actions)
- Vitest configured with first unit tests (health response shape, config validation)

**Explicitly NOT in Slice 0.1:** Supabase Auth wiring, Prisma schema/migrations, RLS, seed data, Sentry, branch protection — these are Slices 0.2–0.5 (proposed split below, each approved separately):

- **0.2** Prisma + Postgres + Phase 0 schema + migrations + seed
- **0.3** Supabase Auth + organisations/memberships/roles + JWT guard + RLS policies + isolation tests
- **0.4** Sentry + logging hardening + health/ready + CI completion + staging deploy to Railway
- **0.5** E2E scaffold (Playwright) + Phase 0 approval-gate evidence pack

## 10. Files Expected to Be Created (Slice 0.1)

```text
package.json · pnpm-workspace.yaml · tsconfig.base.json · .gitignore · .env.example
.nvmrc · .node-version · .eslintrc → eslint.config.mjs · .prettierrc.json
apps/web/  (Next.js scaffold: package.json, next.config, app/, tailwind config)
apps/api/  (NestJS scaffold: package.json, nest-cli.json, src/main.ts, src/app.module.ts,
            src/modules/monitoring/health.controller.ts, common/logger, common/correlation)
apps/worker/ (package.json, src/main.ts, src/inngest/ + one example function)
packages/design-system/ · packages/ui/ (shell) · packages/types/ · packages/validation/
packages/configuration/ · packages/testing/
infrastructure/docker/Dockerfile.api · Dockerfile.worker · docker-compose.yml
infrastructure/ci/ (moved to .github/workflows/ci.yml per GitHub convention)
docs/PHASE-0-PLAN.md (this file)
```

Estimated: ~45–60 files, mostly scaffold configuration. No business logic.

## 11. Risks and Assumptions

| #   | Risk / Assumption                                                                    | Mitigation                                                                                                                      |
| --- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Supabase project not yet created** (user task, Appendix A) — blocks Slice 0.3      | Create early during Phase 0; **region (London) is irreversible** — must be eu-west-2 at creation                                |
| 2   | **Railway account not yet created** (user task) — blocks Slice 0.4 staging deploy    | Create during Phase 0; Hobby plan $5/mo                                                                                         |
| 3   | **Sentry project not yet created** (user task) — blocks Slice 0.4                    | Create during Phase 0; free tier sufficient                                                                                     |
| 4   | Inngest Cloud vs self-host not specified in BRD ("self-hostable")                    | Propose **Inngest Cloud free tier** for dev/staging/prod (managed, zero ops); self-host remains an option. Flagged for approval |
| 5   | Test runner not named in BRD                                                         | Vitest proposed in Section 6 — approval requested                                                                               |
| 6   | Node version drift on other machines                                                 | `.nvmrc`/`.node-version` + engines pin; fnm auto-switch configured on this machine                                              |
| 7   | Next.js 16 / NestJS 11 / Prisma 7 are recent majors — integration surprises possible | Pin exact versions in lockfile; smoke-test the scaffold in Slice 0.1 before building on it                                      |
| 8   | GitHub branch protection not yet enabled (needs repo admin)                          | User to enable (or approve Builder to set via `gh` CLI): PR + CI green required on `main`                                       |
| 9   | Assumption: demo/seed data never triggers real provider sends (BRD 18.6)             | Seed org flagged `is_demo`; send paths will hard-check it (Phase 1)                                                             |
| 10  | Assumption: single Railway project hosts both staging and production environments    | Railway environments feature; documented in Slice 0.4                                                                           |

---

**Approval requested for:** this plan as a whole, including the two flagged proposals (Vitest, Inngest Cloud) and the Slice 0.1–0.5 split. On approval, the Builder executes **Slice 0.1 only**, then stops and reports per Rule 7.
