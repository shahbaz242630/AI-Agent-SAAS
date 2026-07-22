# EVA — Security & Quality Gate Strategy (Enterprise Checklist Handoff)

> **Purpose:** the living security-testing standard for Eva. It defines what we test, with which tools, at which stage of CI/CD, and how security gaps are logged and closed. Read alongside `PHASE-0-HANDOFF.md`; the BRD remains the governing spec (§13 testing, §15 security, §19 rules, §26 DoD).
>
> **Status:** v1.1 — 2026-07-22. Repo is **public** (founder decision) → branch protection, CodeQL, secret scanning + push protection are enabled free. Reviewed and extended at every phase gate. Frameworks referenced: OWASP Top 10 (2025), OWASP ASVS 5.0 (target: **L1 pre-launch, L2 for financial-data flows**), OWASP WSTG v4.2, NIST SSDF SP 800-218.

---

## 1. The rule in one paragraph

No code reaches `main` except through a PR with all automated gates green. Security testing is layered: **our own test suites** (tenant isolation, auth, webhooks — the things only we can test), **scanners** (SAST, dependencies, secrets, containers, pipelines), and **humans** (annual penetration test + per-slice security review). Every gap found — by scanner, test, or human — is logged in the Gap Register (Section 7) and closed within its severity SLA.

## 2. Test categories → tools

| #   | Category                         | What it catches                                           | Tool                                                                                                                       | When it runs                                  |
| --- | -------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| 1   | Application security test suites | Tenant isolation, auth bypass, webhook forgery, injection | Vitest + real Postgres (existing)                                                                                          | Every PR (blocking)                           |
| 2   | SAST (static analysis)           | Injection sinks, unsafe APIs, taint flows                 | **CodeQL** (default setup, enabled repo-level — free on public repos)                                                      | Every PR (blocking)                           |
| 3   | Dependency scanning (SCA)        | Known CVEs in packages                                    | Dependabot alerts + security updates (repo-level) · `pnpm audit --audit-level=high` CI gate · **dependency-review-action** | Every PR (blocking)                           |
| 4   | Secrets scanning                 | Leaked keys/tokens in commits                             | **GitHub secret scanning + push protection** (repo-level) + **gitleaks** (CI: PR diff + weekly full history)               | Every push + PR + weekly                      |
| 5   | Pipeline/IaC scanning            | Over-privileged workflows, unpinned actions, misconfig    | **zizmor** (every PR) + **Trivy fs** misconfig scan (weekly)                                                               | Every PR + weekly                             |
| 6   | Container scanning               | OS-level CVEs in images                                   | **Trivy** image scan + CycloneDX SBOM                                                                                      | Weekly                                        |
| 7   | DAST (dynamic scan)              | Missing headers, cookie flags, runtime misconfig          | **OWASP ZAP Baseline** vs staging; ZAP API Scan vs our OpenAPI spec                                                        | From Slice 0.4 (needs staging)                |
| 8   | Malicious-package detection      | Typosquats, install-time malware                          | Socket (free tier, optional) + pnpm `minimumReleaseAge` (needs pnpm ≥ 10.16 — scheduled)                                   | Every PR                                      |
| 9   | Manual penetration test          | Business-logic flaws, chained exploits                    | External firm / PTaaS (~$5–25k)                                                                                            | **Pre-launch, then annually** + major changes |

## 3. Application-specific security suites (the layer scanners can't do)

These are mandatory automated tests, built slice-by-slice as the features land:

1. **Tenant isolation — both layers, per BRD §13/§15** (Slice 0.3):
   - App layer: tenant A cannot read/update/delete tenant B's records via any API route; cannot create a record carrying B's `organisation_id` (rejected by RLS `WITH CHECK`).
   - RLS layer: same attacks executed directly against Postgres, bypassing the app.
   - **Migration lint:** CI fails if any tenant-owned table lacks `ENABLE ROW LEVEL SECURITY` + policy.
   - Known RLS traps to test against (from Postgres/Supabase docs): table owners bypass RLS unless `FORCE ROW LEVEL SECURITY`; superuser/`BYPASSRLS` roles (incl. Supabase service-role key) bypass by design; views bypass unless `security_invoker = true`; tenant context must be `SET LOCAL` inside a transaction — never session-level `SET`, which leaks across pooled connections (Supavisor/PgBouncer).
2. **AuthN/authZ** (Slice 0.3): expired/wrong-audience/tampered/`alg=none` JWTs → 401; data-driven role × endpoint permission matrix (six BRD §7 roles); authz data in `app_metadata`, never `user_metadata`.
3. **Webhook signature verification** (as each provider lands): Paddle (`Paddle-Signature` HMAC over the **raw** body), Inngest (signing keys), Microsoft Graph (`validationToken` handshake + `clientState` on every notification). Generic cases per endpoint: missing/wrong signature → 401; tampered body → 401; replayed old timestamp → rejected; timing-safe comparison.
4. **Input validation:** negative tests per DTO (oversized payloads, type confusion, injection strings) — AI-facing text fields are both SQLi _and prompt-injection_ sinks (OWASP LLM Top 10 applies to our agents).
5. **Rate limiting:** burst tests → 429 on auth and webhook endpoints.
6. **Security headers/cookies:** CSP, HSTS, `X-Content-Type-Options`, cookies `Secure`/`HttpOnly`/`SameSite` — asserted in tests, drift caught by ZAP baseline.
7. **GDPR/compliance automation:** PII-in-logs guard (emit fake PII in tests, assert redaction); Sentry scrubbing test; cascade-delete verification per tenant (doubles as GDPR Art. 17 erasure evidence); audit-event completeness test for every state-changing endpoint; AI client config test asserting no-training/no-retention flags; deploy-time data-residency assertion (Supabase = eu-west-2).

## 4. CI/CD gate map — what runs on every push/PR

**On every pull request (all blocking) — LIVE since 2026-07-22:**

- Verify job: install → build → lint → typecheck → unit/integration tests (incl. Postgres service) → format check
- Security scans job: gitleaks (secrets) · `pnpm audit --audit-level=high` · zizmor (workflow security)
- Dependency review job: blocks PRs introducing high/critical vulnerable deps
- CodeQL SAST + secret scanning + push protection (repo-level, run on every PR/push automatically)
- Security suites from Section 3 (as they land per slice)

**Scheduled (weekly, alerting not blocking) — `security-weekly.yml`:** gitleaks full history · Trivy filesystem scan · Trivy image scans (api + worker) · SBOM artifact. ZAP baseline/API scans join once staging exists (Slice 0.4).

**Merge to `main`:** PR only, green CI required (`protect-main` ruleset, strict status checks, squash-only, linear history, no force-push/deletion). Staging auto-deploys on Railway **with "Wait for CI" enabled** (Slice 0.4).

**Production:** Railway autodeploy **disabled**; deploy is a deliberate manual action by the founder. Later: a `workflow_dispatch` workflow bound to a `production` GitHub Environment (secrets scoped to the environment; deploys restricted to `main`).

## 5. GitHub workflow protection — live configuration

The `protect-main` ruleset is **active** (applied 2026-07-22, ruleset id 19557864):

| Setting                         | Value                                          | Notes                                                                                                                                 |
| ------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Require pull request            | On                                             | Nothing pushes directly to `main`                                                                                                     |
| Required approvals              | **0 — standing (founder decision 2026-07-22)** | Bot account was blocked; builder commits as founder. Founder reviews every PR by process; revisit if a second committer joins (G-003) |
| Dismiss stale approvals         | On                                             | Ready for when approvals switch on                                                                                                    |
| Require conversation resolution | On                                             | No ignored review comments                                                                                                            |
| Required status checks          | `verify` job, strict mode                      | Extend with `Security scans`/`dependency-review`/CodeQL contexts as their names are observed                                          |
| History                         | Linear, squash-only, auto-delete branches      | One reviewed commit per PR; easy reverts                                                                                              |
| Force push / deletion           | Blocked                                        | History can't be rewritten                                                                                                            |
| Signed commits                  | Off for now                                    | Revisit post-launch                                                                                                                   |

**Enabled at repo level (2026-07-22):** dependency graph · Dependabot alerts + security updates · secret scanning + **push protection** · CodeQL default setup (javascript-typescript + actions) · private vulnerability reporting. **In repo:** `.github/CODEOWNERS` · `.github/pull_request_template.md` · `.github/dependabot.yml` · `SECURITY.md`. **CI hardening:** all actions SHA-pinned · `permissions: contents: read` · `persist-credentials: false`.

**Still open:** pnpm ≥ 10.16 + `minimumReleaseAge`; ZAP (needs staging, Slice 0.4). Required approvals stay 0 per founder decision (no bot account) — review discipline is by process, not enforcement.

**Paid-later (post-launch, needs an org on GitHub Team):** nothing urgent — public-repo free tier covers our needs; revisit only if the repo goes private again. Environment required-reviewers need Enterprise — Railway manual deploy is our production gate instead.

## 5a. Security control coverage matrix (founder checklist)

| Area                | Control                                                                                                                                          | Status                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| Auth                | Supabase Auth (email/password + MFA) · NestJS JWT guard on every route except health · negative JWT tests · role-permission matrix               | Slice 0.3 (planned, tests specced §3.2)        |
| Encryption          | TLS in transit (platform-provided) · encryption at rest (Supabase) · provider tokens encrypted at rest (Phase 1) · no secrets in repo (scanning) | Platform ✅ · token encryption Phase 1         |
| Session handling    | HTTP-only secure cookies · short-lived tokens + refresh rotation (BRD 9.5) · `aal2` for sensitive ops once MFA wired · honest JWT-expiry model   | Slice 0.3 (planned)                            |
| Rate limiting       | Rate limits on public endpoints (auth, webhooks) · burst tests → 429                                                                             | Slice 0.4 (planned, tests specced §3.5)        |
| Error boundaries    | React error boundaries (web) + Nest global exception filter — sanitized errors, no stack traces/PII to clients · tested                          | Slice 0.4 (add to its pre-code report)         |
| Input validation    | zod/class-validator on every inbound boundary · negative tests per DTO (§3.4)                                                                    | Pattern live since 0.1 · suites grow per slice |
| Logging             | Structured JSON + correlation IDs (live) · value-free logs (no PII/financial detail) · PII-redaction guard test                                  | Live · redaction test in Slice 0.4             |
| Backup              | Supabase daily backups + PITR (BRD 18.4) · manual off-site `pg_dump` while on free tier (G-006) · restore drill pre-launch                       | G-006 open · drill pre-launch                  |
| Monitoring          | Sentry (web/api/worker DSNs) + PII scrubbing test · health/ready endpoints · uptime + metrics baseline                                           | Slice 0.4 (planned)                            |
| Dependency scanning | Dependabot alerts/updates · `pnpm audit` gate · dependency-review-action · Trivy weekly · SHA-pinned actions                                     | **Live since 2026-07-22**                      |

## 6. Per-slice security duties (standing)

- Every slice's pre-code report lists its security considerations (already Rule 2 practice).
- Every slice touching an endpoint adds/extends the Section 3 suites (already Rule 6 / DoD §26).
- Every new provider integration adds webhook-signature tests in the same slice.
- Every migration keeps RLS lint green (from Slice 0.3 onward).
- Every DB/infra change keeps its rollback note current (Rule 10).

## 7. Security Gap Register (living log)

| #     | Date found | Found by              | Description                                                                                                                                                                                                                | Severity | SLA               | Status                                                                                                             |
| ----- | ---------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------------- | ------------------------------------------------------------------------------------------------------------------ |
| G-001 | 2026-07-22 | Security review       | CI ran no security scanners                                                                                                                                                                                                | Medium   | —                 | **Closed 2026-07-22** (CodeQL + gitleaks + audit + zizmor + dependency-review + weekly Trivy; ZAP pending staging) |
| G-002 | 2026-07-22 | Security review       | Branch protection not applied                                                                                                                                                                                              | High     | —                 | **Closed 2026-07-22** (repo public → `protect-main` ruleset active)                                                |
| G-003 | 2026-07-22 | Security review       | Builder agent commits under founder's identity; required approvals stay 0 — founder reviews every PR by process. **Founder decision 2026-07-22: risk accepted** (bot account blocked); revisit if a second committer joins | High     | —                 | Closed — risk accepted                                                                                             |
| G-004 | 2026-07-22 | Security review       | `users.email` stored as plain text; uniqueness is case-sensitive — app layer must lowercase (test in Slice 0.3)                                                                                                            | Low      | Slice 0.3         | Open — scheduled                                                                                                   |
| G-005 | 2026-07-22 | Security review       | GitHub Actions not SHA-pinned; `GITHUB_TOKEN` default permissions unrestricted                                                                                                                                             | Medium   | —                 | **Closed 2026-07-22** (all actions SHA-pinned; `contents: read` default)                                           |
| G-006 | 2026-07-22 | Sandoq Kin comparison | Supabase on free tier has no managed backups — manual off-site `pg_dump` required before hosted schema work. **Founder decision 2026-07-22: stay on free tier until post-beta production**, then upgrade to Pro            | High     | Before production | Open — mitigated by manual dumps                                                                                   |

## 7a. Standard Security Verification (run before every slice approval)

```bash
pnpm run build && pnpm run lint && pnpm run typecheck && pnpm run test && pnpm run format:check
pnpm audit --audit-level=high
# DB suites (schema/migration/seed +, from 0.3, RLS attack tests) run inside `pnpm run test`
# CI additionally enforces: gitleaks, zizmor, dependency-review, CodeQL, push protection
```

From Slice 0.4 (adds): ZAP baseline vs staging. Database or RLS changes always re-run the full `@eva/database` suite; release candidates additionally require the deploy gate in Section 4.

**SLAs:** Critical = fix before merge/24h · High = 7 days · Medium = 30 days · Low = next phase. Every scanner/test/pen-test finding gets a row here; the remediation log is what enterprise questionnaires and SOC 2 auditors ask for.

## 8. Adoption roadmap

- **Done 2026-07-22:** repo public → `protect-main` ruleset · CODEOWNERS · PR template · `SECURITY.md` · dependabot.yml · Dependabot alerts + security updates · secret scanning + push protection · CodeQL · SHA-pinned CI with read-only token · gitleaks/audit/zizmor/dependency-review PR gates · weekly Trivy + SBOM + history scan.
- **Founder decision 2026-07-22:** no builder bot account (blocked) — builder commits as founder, approvals stay 0, review by process (G-003 closed, risk accepted).
- **Slice 0.3:** tenant-isolation suites (app + RLS), authZ matrix, JWT negative tests, email-lowercasing test (G-004). Supabase session controls adopted from the Sandoq Kin review: sensitive operations require `aal2` (MFA-verified JWT) once MFA is wired; choose and document a supportable JWT lifetime; old access JWTs remain valid until expiry — never claim instantaneous session displacement.
- **Slice 0.4:** Sentry + PII-redaction test · error-boundary/exception-filter tests · rate limiting + burst tests · ZAP baseline on staging · pnpm ≥ 10.16 + `minimumReleaseAge`.
- **While Supabase stays on the free tier** (until post-beta production, founder decision): take and verify a manual off-site logical backup (`pg_dump`) before any material hosted schema work; upgrade to Supabase Pro at production (G-006).
- **Pre-launch:** external penetration test (scope: tenant isolation, webhooks, AI prompt-injection, OAuth consent flows); ZAP API scan; restore drill (BRD §18.4); pen-test remediation logged in Section 7; SBOM retention ownership defined (CI artifacts expire after 90 days — decide where durable SBOMs live).
- **Post-launch:** signed commits; SOC 2 readiness if enterprise customers ask (the Section 7 remediation log is the evidence base).

## 9. Key sources

- OWASP Top 10 2025 (incl. A03 Software Supply Chain Failures): https://owasp.org/Top10/
- OWASP ASVS 5.0: https://asvs.dev · WSTG: https://owasp.org/www-project-web-security-testing-guide/
- Postgres RLS: https://www.postgresql.org/docs/current/ddl-rowsecurity.html · Supabase RLS: https://supabase.com/docs/guides/database/postgres/row-level-security
- Prisma + RLS reference pattern (`SET LOCAL` per transaction): https://www.pedroalonso.net/blog/postgres-multi-tenant-search/
- GitHub rulesets: https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets
- GitHub Actions hardening: https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions
- Railway deploy gating: https://docs.railway.com/deployments/github-autodeploys
- Paddle webhook signatures: https://developer.paddle.com/webhooks/about/signature-verification · Inngest: https://www.inngest.com/docs/platform/signing-keys · Microsoft Graph: https://learn.microsoft.com/en-us/graph/change-notifications-delivery-webhooks
- ZAP + Actions: https://www.zaproxy.org/blog/2020-05-15-dynamic-application-security-testing-with-zap-and-github-actions/
