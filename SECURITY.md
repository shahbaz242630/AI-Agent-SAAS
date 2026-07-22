# Security Policy

## Reporting a vulnerability

Please report security issues **privately** via GitHub's "Report a vulnerability"
feature (Security tab → Advisories) on this repository. Do not open a public
issue for security reports.

We aim to acknowledge reports within 3 working days.

## Scope

Eva is a pre-launch multi-tenant SaaS. The most valuable reports for us are:

- Cross-tenant data access (one organisation reading another's data)
- Authentication/authorisation bypass (JWT, roles, RLS)
- Webhook signature forgery (Paddle, Inngest, Microsoft Graph)
- Injection (SQL, prompt injection against AI features)

## Our security standard

See `docs/SECURITY-TESTING-STRATEGY.md` — it defines our testing layers,
CI/CD gates, and the living gap register.
