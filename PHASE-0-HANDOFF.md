# EVA — Phase 0 Handoff & Progress Document

> **Purpose of this document:** This is the Builder's session-onboarding file. At the start of every new session, read THIS document (not the full BRD) to get up to speed: what the project is, the stack, the rules, what is done, and what to do next. It is updated after every completed slice/phase. The full BRD remains the source of truth for detail — consult it when a section is referenced.

**Full specification:** `Eva BRD v1.2 - Consolidated Build Specification.md` (root)

---

## 1. Session Opener (read first, every session)

**Current status — 22 July 2026:**

Phase 0 (Project Foundation) is underway. Environment setup is complete (Node 22.23.1 via fnm, pnpm 10.15.0, Docker 28.5.2, repo `https://github.com/shahbaz242630/AI-Agent-SAAS.git` — **PUBLIC**). Decisions: hosting = Railway · Docker per BRD 9.11 · pnpm · Node 22 LTS · Vitest · Inngest Cloud. The Section 27 Phase 0 plan (`docs/PHASE-0-PLAN.md`) is APPROVED. **Slice 0.2 is MERGED** (`ad16692`, PR #1). **Security layer is MERGED** (`3f89ff5`, PR #2): `protect-main` ruleset (PR-only, green CI required, squash-only), CodeQL, secret scanning + push protection, Dependabot, gitleaks/audit/zizmor/dependency-review PR gates, weekly Trivy + SBOM — see `docs/SECURITY-TESTING-STRATEGY.md`. **Founder decisions 2026-07-22:** no bot account — builder commits as founder; required PR approvals stay 0, founder reviews every PR by process (G-003 closed, risk accepted) · Supabase stays on free tier until post-beta production (G-006 remains: manual `pg_dump` before hosted schema work). Next slice: **0.3 (Supabase Auth + RLS)** — blocked only on the founder creating the Supabase project in **eu-west-2** (account setup underway). Nothing may be built beyond the currently approved slice.

---

## 2. Project Snapshot

**Eva** — a modular, cloud-first AI business communications SaaS for UK micro/small businesses (launch market: Slough, UK). Commercial model: modular SaaS via Paddle (Merchant of Record). Four modules, each independently enabled, billed, tested and deployed:

| #   | Module                  | Phase | Summary                                                                                       |
| --- | ----------------------- | ----- | --------------------------------------------------------------------------------------------- |
| 1   | Email Credit Controller | 1     | Overdue-invoice email reminders via customer's Microsoft 365 mailbox (Microsoft Graph)        |
| 2   | Voice Credit Controller | 2     | AI voice follow-up calls on genuine outstanding invoices (Vapi + Twilio UK)                   |
| 3   | Lead Follow-Up Agent    | 3     | Rapid callback of inbound leads (web forms, email enquiries, WhatsApp Business, missed calls) |
| 4   | AI Receptionist         | 4     | Inbound call answering, routing, message capture                                              |

Phase 5 = installable PWA. Phase 6 = optional Tauri desktop client (demand-gated only). Web-first: no downloadable client before Phase 5/6.

Delivery order: responsive web app (primary) → PWA → optional desktop. Cloud API + database are the source of truth for all channels; closing any client must never interrupt automation.

---

## 3. Decided Technology Stack (binding — BRD Section 9)

| Concern                | Decision                                                                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Frontend               | Next.js 16 (App Router), React 19, TypeScript 5 strict, Tailwind CSS v4, shadcn/ui, react-hook-form + zod                                                    |
| Backend API            | NestJS 11 (Express 5 adapter), REST + OpenAPI spec → typed `packages/api-client`                                                                             |
| Runtime                | Node.js 22 LTS                                                                                                                                               |
| Background processing  | Inngest (durable functions). Fallback: Trigger.dev. **Prohibited:** Celery, Python workers, Temporal, hand-rolled cron                                       |
| Database               | PostgreSQL 16+ on Supabase, **London region (eu-west-2)**; Prisma 7 ORM; forward-only migrations with rollback notes                                         |
| Tenant isolation       | Application-layer scoping on EVERY query **plus** Postgres Row Level Security (both tested)                                                                  |
| Auth                   | Supabase Auth (email/password + MFA); HTTP-only secure cookies; short-lived tokens + refresh rotation; NestJS guard validating Supabase JWT on every request |
| Customer email         | Microsoft Graph (multi-tenant app, OAuth, minimal scopes: `Mail.Send`, `Mail.Read`, `offline_access`, `User.Read`)                                           |
| Transactional email    | Resend (fallback: Postmark) behind notifications module                                                                                                      |
| Voice                  | Vapi (primary; recording/transcript retention disabled) + Twilio UK geographic numbers. Fallback: Retell AI                                                  |
| Payments               | Paddle (Merchant of Record); platform entitlement engine is source of truth                                                                                  |
| AI                     | OpenAI API structured outputs behind internal adapter; versioned prompts; no training on customer data                                                       |
| Monitoring             | Sentry (web/api/worker); structured JSON logs with correlation IDs                                                                                           |
| CI/CD                  | GitHub Actions — lint, typecheck, unit tests, build on every PR; staging on merge; production manual                                                         |
| Environments           | dev (local Docker Compose) · staging · production                                                                                                            |
| Packaging              | Docker containers for `api` and `worker`; Docker Compose for local dev                                                                                       |
| Hosting                | **Railway** (decided 2026-07-21) — Docker deploys for `api` + `worker`; web on Vercel or Railway                                                             |
| Desktop (Phase 6 only) | Tauri v2 reusing shared packages                                                                                                                             |

**Stack substitutions are prohibited** without an approved architectural-change report (BRD 3.8, Rule 9).

---

## 4. Repository Structure (BRD Section 8 — build exactly this, nothing more)

```text
apps/
  web/                  # Next.js 16 responsive web app (PWA-ready from Phase 5)
  api/                  # NestJS 11 backend API
  worker/               # Background workers (Inngest consumers, schedulers)

packages/
  ui/                   # Shared UI components
  design-system/        # Tokens, Tailwind theme
  api-client/           # Typed API client generated from OpenAPI spec
  types/                # Shared TypeScript types and contracts
  validation/           # Shared validation schemas (zod)
  authentication/       # Auth helpers
  entitlements/         # Entitlement-check helpers
  configuration/        # Shared config handling
  testing/              # Test utilities and factories

modules/                # Backend business modules (inside apps/api, enforced boundaries)
  organisations/  users/  billing/  entitlements/  contacts/  customers/
  invoices/  email-credit-control/  voice-credit-control/  lead-follow-up/
  receptionist/  communications/  scheduling/  integrations/  notifications/
  audit/  monitoring/

infrastructure/
  database/             # Migrations, seed
  docker/               # Dockerfiles, compose for local dev
  ci/                   # GitHub Actions workflows
  deployment/           # Environment configuration
```

- `apps/desktop` must NOT exist before Phase 6.
- No placeholder/stub scaffolding of future modules (Rule 11).
- Provider access ONLY via adapters in `modules/integrations` — never scattered direct calls.

---

## 5. Binding Builder Rules (condensed from BRD Sections 3 & 19)

1. **Small approval-gated slices only.** Build one approved slice, then STOP and wait for approval.
2. **Before coding any slice, report:** feature · why · dependencies · files expected to change · tests to add · risks.
3. Keep changes small; no unrelated refactors.
4. Preserve module boundaries; cross-module access only via exported service contracts.
5. One clear responsibility per function; single controlled service per business state (e.g. invoice status changes only through the invoices state machine).
6. Before completing a slice: new tests + related existing tests + lint + typecheck + build all pass.
7. **After every slice, report:** implemented · not implemented · tests added · test results · files changed · migrations · security considerations · monitoring · known limitations · manual test steps · recommended next slice.
8. Stop after every slice; continue only after approval.
9. Never silently change scope, stack or architecture.
10. Every DB/infra change includes rollback guidance.
11. No placeholder debt; no scaffolding of future phases.
12. If the spec is silent on a needed decision — STOP and ask, don't guess.

**Hard product rules:** AI never controls high-risk actions (legal threats, fees, discounts, marking paid, commitments); human confirms all AI-proposed invoice state changes; no call audio/full transcripts/voice biometrics retained; AI discloses itself on every call; suppression list is permanent and cross-channel; no consent evidence → no lead call; calling hours 08:00–21:00 UK; all business logic in org timezone (default Europe/London), timestamps in UTC; money as integer minor units (pence) + currency code.

**Definition of Done (BRD 26):** code + boundaries + validation + permissions (app + RLS) + unit/integration/e2e tests + error handling + logs + metrics + docs + migration/rollback docs + security review + manual test steps + limitations + approval.

---

## 6. Phase Roadmap & Progress Tracker

- [ ] **Phase 0 — Project Foundation** ← CURRENT
  - [x] Environment setup (git link, toolchain, hosting decision)
  - [x] Section 27 pre-code plan produced and approved (`docs/PHASE-0-PLAN.md`)
  - [x] **Slice 0.1** — repo structure per Section 8 · TypeScript strict, linting, formatting · testing framework (Vitest) · Docker Compose + Dockerfiles · health endpoint · CI workflow · Inngest skeleton + example function · base design system + ui shell
  - [x] **Slice 0.2** — Prisma 7 + Postgres + Phase 0 schema + migrations + seed data (PR `agent/slice-0.2-database`)
  - [ ] **Slice 0.3** — Supabase Auth + organisations/memberships/roles + JWT guard + RLS policies + isolation tests
  - [ ] **Slice 0.4** — Sentry + logging hardening + health/ready + staging deploy to Railway
  - [ ] **Slice 0.5** — Playwright e2e scaffold + Phase 0 approval-gate evidence pack
  - [ ] **Approval gate:** build/lint/typecheck/tests pass · tenant isolation demonstrated (app + RLS) · secrets excluded · health endpoint works · seed loads · staging deploys
- [ ] **Phase 1 — Email Credit Controller** (Slices 1.1–1.10, see BRD Section 20)
- [ ] **Phase 2 — Voice Credit Controller** (Slices 2.1–2.8; starts with Vapi spike)
- [ ] **Phase 3 — Lead Follow-Up Agent** (Slices 3.1–3.8 incl. email + WhatsApp intake)
- [ ] **Phase 4 — AI Receptionist** (Slices 4.1–4.10)
- [ ] **Phase 5 — PWA**
- [ ] **Phase 6 — Optional Tauri desktop** (demand-gated)

---

## 7. Environment Status

| Tool            | Required                      | Installed                                        | Status    |
| --------------- | ----------------------------- | ------------------------------------------------ | --------- |
| Git             | any                           | 2.53.0                                           | ✅        |
| Node.js         | 22 LTS                        | **v22.23.1 via fnm** (default; v24 also present) | ✅ pinned |
| Package manager | **pnpm** (decided 2026-07-21) | 10.15.0                                          | ✅        |
| fnm             | —                             | installed via scoop; hook added to `~/.bashrc`   | ✅        |
| Docker          | any                           | 28.5.2                                           | ✅        |
| GitHub repo     | —                             | linked to working dir, branch `main`             | ✅        |

**Business-side prerequisites (Appendix A, user's responsibility):** GitHub org/repo ✅ · Supabase project (London) ⏳ · Microsoft 365 dev tenant (by Slice 1.6) · Paddle application (submit early) · Sentry project ⏳ · hosting account ⏳ · OpenAI API (by Slice 1.4) · Twilio + Vapi (Phase 2) · Meta Business (Phase 3).

---

## 8. Key Files

| File                                                 | Purpose                                                   |
| ---------------------------------------------------- | --------------------------------------------------------- |
| `Eva BRD v1.2 - Consolidated Build Specification.md` | Full governing specification (source of truth for detail) |
| `PHASE-0-HANDOFF.md`                                 | This document — session onboarding + progress tracking    |
| `docs/PHASE-0-PLAN.md`                               | Section 27 pre-code plan — **approved 2026-07-21**        |
| `package.json` / `pnpm-workspace.yaml`               | Workspace root (Node 22 + pnpm pinned)                    |
| `apps/api/src/main.ts`                               | API bootstrap (NestJS 11)                                 |
| `apps/api/src/modules/monitoring/`                   | Health endpoint module                                    |
| `apps/worker/src/main.ts`                            | Worker bootstrap (Inngest serve endpoint)                 |
| `infrastructure/docker/docker-compose.yml`           | Local dev environment (postgres, api, worker)             |
| `infrastructure/database/prisma/schema.prisma`       | Phase 0 schema (6 tables, BRD 10 conventions)             |
| `infrastructure/database/prisma/migrations/`         | Forward-only migrations + per-migration ROLLBACK.md       |
| `infrastructure/database/src/seed.ts`                | Idempotent demo seed (flagged is_demo)                    |
| `docs/SECURITY-TESTING-STRATEGY.md`                  | Security testing standard + gap register (living)         |
| `.github/workflows/ci.yml`                           | CI: install → build → lint → typecheck → test → format    |

_(This table grows as the project grows — add key entry-point files as they are created: package.json, prisma schema, docker-compose, CI workflows, etc.)_

---

## 9. Open Decisions / Questions

1. ~~Hosting provider~~ — **DECIDED 2026-07-21: Railway.** Justification: usage-based pricing is cheapest for our two-service Docker workload (~$8–15/mo early), best-in-class monorepo/environment DX, and Nixpacks-or-Dockerfile deploys keep migration cost near zero if we ever switch.
2. ~~Package manager~~ — **DECIDED 2026-07-21: pnpm** (installed v10.15.0; monorepo workspace standard).
3. ~~Node version~~ — **DECIDED 2026-07-21: Node 22 LTS installed via fnm** (v22.23.1, set as fnm default; per BRD 9.2). Repo will pin it via `.nvmrc`/`.node-version` + `package.json` engines.

---

## 10. Progress Log

_Newest entries on top. One entry per completed slice/phase or approved milestone._

| Date       | Entry                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2026-07-22 | **Slice 0.2 MERGED** (`ad16692`, PR #1) **+ security layer MERGED** (`3f89ff5`, PR #2). First slices through the new PR workflow. Security setup: repo public → `protect-main` ruleset active · CodeQL · secret scanning + push protection · Dependabot (alerts + security updates + weekly version PRs, 7-day cooldown) · private vuln reporting · CODEOWNERS/PR template/SECURITY.md · CI SHA-pinned with read-only token · gitleaks + pnpm audit + zizmor + dependency-review PR gates · weekly Trivy + SBOM workflow. Gates fired immediately: 3 dependency CVEs fixed via lockfile overrides (adm-zip, sharp, postcss — zero known vulns), vulnerable trivy-action replaced (v0.36.0). **Founder decisions:** no bot account (builder commits as founder, approvals stay 0 — G-003 risk accepted) · Supabase free tier until post-beta production (G-006 stands: manual `pg_dump` before hosted schema work). |
| 2026-07-22 | **Slice 0.2 COMPLETE — delivered as PR `agent/slice-0.2-database`** (first slice under the new PR workflow). `@eva/database` package: Prisma 7.9.0 + driver adapter, Phase 0 schema (6 tables: organisations, organisation_settings, users, roles, organisation_memberships, audit_logs — BRD 10 conventions), forward-only migration `20260722125535_init` + verified ROLLBACK.md, idempotent demo seed (is_demo flagged). 14 new tests (TDD; 20/20 workspace green), CI gains postgres service. Security strategy produced (`docs/SECURITY-TESTING-STRATEGY.md`) from deep research + Sandoq Kin comparison; repo made **public** (free branch protection/CodeQL/secret scanning); security CI/CD hardening follows as a separate PR. Pending: bot account for builder, Supabase project (eu-west-2) before Slice 0.3.                                                                                           |
| 2026-07-21 | **Slice 0.1 APPROVED, committed and pushed** (`5d55173` + fix `9b779a7`). Approved with "hold" — Slice 0.2 does not start until the user says go. pnpm monorepo scaffold (apps web/api/worker + 6 shared packages), TS 5 strict, ESLint 9 + Prettier, Vitest (6 tests passing), NestJS health endpoint with correlation IDs + helmet + JSON logs, Inngest skeleton with example durable function, Dockerfiles + Compose (images build; api container serves /health), GitHub Actions CI. Fixes during verification: @types/node in configuration/ui packages, zod deps in api/worker, nestjs-pino transport typing, .dockerignore + tsconfig.base.json in image context, removed embedded `.git` from `apps/web` scaffold. Working tree clean.                                                                                                                                                                     |
| 2026-07-21 | Section 27 Phase 0 pre-code plan produced at `docs/PHASE-0-PLAN.md` — **approved by user**. Slice 0.1–0.5 split; Vitest and Inngest Cloud approved.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 2026-07-21 | **Environment setup complete.** Decisions: hosting = Railway · Docker per BRD 9.11 · package manager = pnpm · Node 22 LTS via fnm (v22.23.1, default; bash hook added). User reviewed Docker-vs-native alternatives incl. 1k/10k-user scaling analysis; confirmed BRD recommendation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 2026-07-21 | Handoff document created. BRD v1.2 reviewed and confirmed as governing spec. GitHub repo identified. Environment check run (see Section 7). No code written yet.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
