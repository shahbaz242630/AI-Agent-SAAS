# EVA — AI BUSINESS COMMUNICATIONS PLATFORM

## Business Requirements Document and Build Specification

**Document status:** Consolidated build specification (supersedes v1.0 and the v1.1 amendment)
**Version:** 1.2
**Date:** July 2026
**Primary market:** UK microbusinesses and small businesses
**Initial launch area:** Slough and surrounding areas
**Commercial model:** Modular SaaS with optional managed setup
**Payment provider:** Paddle
**Delivery model:** Cloud-first responsive web SaaS → installable PWA → optional Tauri desktop client
**Development approach:** Small, tested and approval-gated feature slices executed by the Builder

---

## Change Log

| Version | Change |
|---|---|
| 1.0 | Initial build specification (Phases 0–4). |
| 1.1 | Approved amendment: cloud-first delivery model, PWA (Phase 5), optional Tauri desktop client (Phase 6). |
| 1.2 | Consolidated v1.0 + v1.1 into one authoritative document. Pinned all open technology decisions. Added UK regulatory section (PECR, TPS/CTPS, calling hours, suppression lists, data residency). Added deployment/environments, timezone model, reply detection, concrete provider limits, transactional email, expanded data model, expanded Phase 0, pre-build checklist. Defined "the Builder" and repaired blank agent-name placeholders. Removed outdated options (Auth.js, Clerk, FastAPI alternative, Celery/Python workers, Temporal). |
| 1.2.1 | Lead intake expanded: WhatsApp Business and email inquiries added as approved lead sources with defined intake mechanics and per-channel consent evidence (Section 4.3). Added messaging-provider interface (Section 11), Phase 3 intake slices, WhatsApp non-goals, and Meta Business prerequisites (Appendix A). Reaffirmed web-first delivery: no downloadable client before Phase 5/6. |

## Terminology

* **Eva** — the product and its AI persona.
* **Organisation** — a subscribed business (tenant).
* **The Builder** — the AI coding agent (e.g. Kimi Code) implementing this specification. Every rule addressed to "the Builder" is binding.
* **Module** — one of the four product capabilities defined in Section 4.
* **Provider** — an external service (Microsoft, Paddle, voice, calendar, AI) integrated behind an internal adapter.

> **Precedence rule:** This v1.2 document is the single source of truth. Where v1.0 or the v1.1 amendment conflict with it, v1.2 wins. No earlier document may be handed to the Builder.

---

# 1. Executive Summary

Eva is a modular, cloud-based AI business communications platform for small businesses.

The platform helps businesses:

1. Chase overdue invoices by email.
2. Follow up overdue invoices through an AI voice agent.
3. Call new inbound leads generated through websites and approved channels.
4. Answer incoming calls through an AI receptionist.

Businesses may subscribe to one module, any combination of modules, or the complete Eva suite.

The system must be designed as a modular platform rather than a tightly coupled monolithic application. Each module must be independently enabled or disabled, tested, monitored, deployed, billed, updated and troubleshot. A failure or code change in one module must not unnecessarily affect another module.

All critical business operations run in the cloud. Closing a browser, PWA or desktop client must never interrupt automation.

The platform must be simple to operate, scalable, secure, observable and easy to debug.

---

# 2. Product Vision

Eva should operate as a practical AI employee for small businesses.

Eva is not intended to replace all human communication. It should automate repetitive, predictable and time-sensitive activities while escalating unusual, sensitive or high-risk situations to a human.

The platform should deliver measurable business outcomes:

* Faster payment collection
* Fewer overdue invoices
* Faster response to new enquiries
* Reduced missed business opportunities
* Improved call coverage
* Reduced administrative workload
* Consistent customer communication
* Better visibility of follow-up activities

---

# 3. Core Product Principles

## 3.1 Modular by design

Each major product capability exists as an independent module:

1. Email Credit Controller
2. Voice Credit Controller
3. Lead Follow-Up Agent
4. AI Receptionist

Shared platform services may be reused, but module-specific business logic must remain separated.

## 3.2 Build in small slices

The Builder must not attempt to build the entire platform in one pass. The required working cycle is:

1. Select one small feature.
2. Explain why the feature is being built.
3. Define the acceptance criteria.
4. Implement the feature.
5. Add tests.
6. Run all relevant tests.
7. Review security and failure scenarios.
8. Report what changed.
9. Report test results.
10. Report known limitations.
11. Stop and wait for approval.
12. Continue only after approval.

## 3.3 Reliability before intelligence

Rule-based workflows control critical business actions.

AI may help with natural conversation, message tone adaptation, reply classification, call-outcome classification, summarisation and suggested responses.

AI must not independently control high-risk actions such as:

* Threatening legal proceedings
* Applying late fees
* Negotiating discounts
* Cancelling invoices
* Changing payment amounts
* Disclosing financial information to an unverified person
* Calling leads without valid permission
* Making commitments on behalf of the business

## 3.4 Human control

Businesses must be able to pause and resume automation, approve templates, set communication schedules, define escalation rules, review activity, correct records, mark invoices as paid, stop contact with a customer or lead, disable individual modules and request human handling.

## 3.5 Privacy by design

The initial voice product will not intentionally retain call audio recordings, full call transcripts, voiceprints or biometric voice analysis.

The system may retain minimum structured information needed to perform the service: call date and time, duration, answered status, outcome, promise-to-pay date, appointment details, follow-up action, short factual notes, failure reason and human-escalation requirement.

Temporary audio and text processing data must be deleted as soon as technically practical after the structured outcome has been produced. Provider accounts (voice, AI) must be configured with recording and transcript retention disabled, and this configuration must be verified in the Phase 2 provider spike.

## 3.6 Cloud-first delivery

Eva is a cloud-first, responsive web-based SaaS platform. All critical operations run in the cloud and must not depend on a customer's laptop, browser session, desktop application or internet connection remaining active.

Customer access channels, in delivery order:

1. Responsive web application (primary)
2. Installable Progressive Web App (Phase 5)
3. Optional Tauri desktop application (Phase 6, only if demand is validated)
4. Possible future mobile application (out of scope for this specification)

The cloud API and database are the source of truth for all channels. No client contains business logic beyond presentation, validation and drafts.

## 3.7 One language, one backend

The platform is TypeScript end-to-end for Phases 0–4: Next.js frontend, NestJS backend, TypeScript workers. No Python services, no second backend framework. This removes the duplication risk identified in earlier revisions.

## 3.8 Decided defaults

Where this specification names a technology, provider or default value, the Builder must implement that decision and must not substitute alternatives or re-open the decision. A deviation requires an explicit architectural-change report and approval before implementation (see Section 19, Rule 9).

---

# 4. Product Modules

## 4.1 Module One: Email Credit Controller

### Purpose

The Email Credit Controller is the first product module. It provides a lower-risk and lower-cost foundation for invoice-collection automation before voice calling is added. It allows the business to automatically send professional overdue-invoice reminders through its connected Microsoft 365 Outlook mailbox.

### Why this module is built first

It establishes the core data and workflow foundation required by the Voice Credit Controller. It validates invoice importing, customer records, due-date calculations, reminder scheduling, payment status, communication history, Outlook integration, template management, retry handling, audit trails and multi-tenant security.

The Voice Credit Controller must not be built until the invoice and customer workflow is stable.

### Primary capabilities

* Manual invoice entry
* CSV and Excel invoice import
* PDF invoice upload and data extraction
* Human review before activation
* Customer record creation
* Invoice status tracking
* Due-date calculation
* Overdue-invoice identification
* Configurable reminder sequences
* Outlook email sending via Microsoft Graph
* Email templates with business tone settings
* Invoice attachment
* Pause and resume controls
* Mark-as-paid control
* Promise-to-pay, dispute and wrong-contact statuses
* Reply detection with assisted outcome classification
* Bounce (NDR) detection
* Email delivery and failure logs
* Activity timeline
* Audit log
* Dashboard reporting

### Invoice statuses

Draft · Active · Due soon · Due today · Overdue · Promise to pay · Disputed · Paused · Partially paid · Paid · Written off · Cancelled

Status transitions must be implemented as a single, explicit state machine inside the invoices module. No other code path may change invoice status except through that service.

### Reminder stages

Default reminder stages (all configurable; a business can enable, disable or edit each stage):

* Three days before due date
* On due date
* Seven days overdue
* Fourteen days overdue
* Thirty days overdue
* Final internal escalation

### Email generation

The default approach uses approved templates rather than generating every email from scratch with AI. AI may be used during onboarding to adapt templates to the owner's preferred tone (warm and friendly · professional · direct · firm but respectful). The approved version must be stored, versioned and used consistently. Free-form AI-drafted customer emails are a non-goal (Section 24).

### Sending requirements

Emails are sent through the customer's connected Microsoft 365 mailbox using Microsoft Graph.

* Authentication uses OAuth (multi-tenant app registration, minimal scopes: `Mail.Send`, `Mail.Read`, `offline_access`, `User.Read`).
* The platform must never store the customer's Microsoft password.
* Emails must be sent from the business's real mailbox, appear in Sent Items where supported, use the business signature, include invoice number, amount due, due date and payment instructions, attach or link the invoice where appropriate, and provide a valid reply path.
* OAuth tokens must be encrypted at rest; refresh is automatic with health-status surfacing.

### Provider limits and safe sending defaults

Microsoft Graph enforces approximately 10,000 requests per 10 minutes per application per mailbox and returns HTTP 429 with a `Retry-After` header when throttled; Microsoft 365 business mailboxes are limited to 10,000 recipients per day. The platform must engineer well below these ceilings.

Safe defaults (organisation-configurable within platform caps):

* Daily sending limit: 200 emails per connected mailbox
* Hourly sending limit: 50 per mailbox
* Minimum spacing between sends from one mailbox: 60 seconds
* Minimum interval between reminders to the same contact: 3 days
* All 429 responses honoured via `Retry-After` with exponential backoff and jitter
* Hard retry limit per send job: 5 attempts, then failed-job state with alert

### Sending safety controls

The platform must enforce daily and hourly sending limits, minimum time between reminders, duplicate-send prevention, retry limits, bounce handling, failed-authentication handling, mailbox health checks, invoice-status revalidation immediately before sending, dispute checks, payment-status checks and stop-contact/suppression checks.

The system must not send an email solely because a scheduled job exists. It must re-check current invoice state inside the send transaction.

Duplicate-send prevention mechanism (mandatory): an idempotency key plus a unique database constraint on (invoice, reminder step, scheduled date); the send worker claims the job with a conditional update, revalidates state, sends, and records the result atomically.

### Reply detection and outcome workflow

The platform must subscribe to Microsoft Graph change notifications for the connected mailbox and process inbound replies to tracked reminder threads:

1. Reply received → matched to invoice/customer thread.
2. AI classifies the reply (promise to pay · paid claim · dispute · invoice copy request · wrong contact · question · out of office · other) with a confidence score.
3. High-confidence classifications propose the outcome; **a human confirms** before any invoice state change (paid, disputed, promise-to-pay).
4. Low-confidence or sensitive replies are queued for human handling with a notification.
5. Out-of-office replies pause nothing but are logged.

Manual outcome entry (the original Slice 1.8 behaviour) must remain available for replies the platform cannot see (phone calls, letters).

### Bounce handling

Microsoft Graph has no native bounce API. Non-delivery reports arrive as emails in the connected mailbox. The platform must detect NDR messages via the same change-notification pipeline, mark the affected contact's email as failing, pause reminders to that address, and alert the business.

### PDF extraction rule

PDF-extracted data is always treated as a draft. Required flow: upload → extract fields → display extracted fields → highlight uncertain or missing values → require user review → require user confirmation → save as active only after confirmation. A PDF upload must never trigger immediate customer communication. Extraction is performed through the extraction-provider adapter (Section 11) using structured outputs with per-field confidence scores.

## 4.2 Module Two: Voice Credit Controller

### Purpose

The Voice Credit Controller adds AI telephone follow-up to the proven invoice-management foundation. Eva calls existing customers regarding genuine outstanding invoices. These are service calls about a contractual relationship, not direct-marketing calls.

### Dependency

This module depends on Module One and must reuse businesses, customers, contacts, invoices, payment status, reminder schedules, communication preferences, dispute status, promise-to-pay status, activity history, suppression list and audit logs. It must not duplicate invoice-management logic.

### Example opening

"Hello, this is Eva, the AI accounts assistant calling on behalf of ABC International. I am calling regarding an outstanding invoice. Before I continue, may I confirm that you are responsible for accounts payable?"

Eva must identify herself as an AI agent at the beginning of every call.

### Correct-contact verification

Eva must not reveal invoice amount, invoice number, due date, payment history or customer financial information until the correct authorised contact has been reasonably verified.

### Supported outcomes

No answer · Voicemail · Wrong number · Wrong contact · Customer says invoice is paid · Promise to pay · Payment date requested · Invoice copy requested · Invoice disputed · Partial payment reported · Financial difficulty · Human callback requested · Customer refuses AI interaction · Do not call again · Technical failure · Unclear outcome

### Post-call actions

Depending on outcome, the platform may record a promise-to-pay date, pause email reminders, schedule another call, send an invoice copy, alert the business, request payment verification, escalate a dispute, mark the contact as incorrect, add the number to the suppression list, or request a human callback. "Customer says invoice is paid" never marks an invoice paid automatically — it creates a verification task for a human.

### Calling rules

* Calls only within permitted hours (default 08:00–21:00 UK time, organisation-configurable within that envelope; see Section 17).
* Numbers on the suppression list are never called.
* Disputed, paused or paid invoices are never called.
* A valid, owned UK caller ID (CLI) must be presented on every outbound call; withheld numbers are prohibited.
* Maximum attempts per invoice per week: 2 (configurable within platform cap of 3).
* Voicemail: leave at most one short scripted message per invoice per week, disclosing no financial detail beyond the business name and a callback number.

### Voice-agent restrictions

Eva must not pretend to be human, threaten the customer, claim legal action has started, invent fees or penalties, accept card details, request passwords, negotiate discounts without explicit rules, disclose invoice information to third parties, continue after a clear request to stop, argue about a disputed invoice, or mark an invoice as paid solely from an unverified verbal claim.

### Data retention

Do not intentionally retain audio recordings, full transcripts or voice biometric information. Retain only structured operational outcomes and minimum factual notes. The selected voice provider must be configured with recording and transcript retention disabled (verified in Slice 2.1).

### Human handoff

The module must support immediate transfer where technically available, scheduled human callback, dashboard escalation, email/in-app/push notification, priority flags and a clear reason for escalation.

## 4.3 Module Three: Lead Follow-Up Agent

### Purpose

The Lead Follow-Up Agent calls new inbound leads quickly after they make an enquiry. It does not perform unsolicited cold calling or marketing calls of any kind. Purchased cold lists are not supported.

A lead becomes eligible only when the person has **initiated contact with the business** or explicitly requested a callback through an approved channel. Every call must trace back to stored evidence of that inbound enquiry.

### Eligible lead sources

Website contact form · Quote-request form · Booking enquiry · Google lead form · Approved social-media lead form · **WhatsApp Business message enquiry** · **Email enquiry to the business's designated leads address** · Missed inbound call · Existing customer requesting another service · Explicit callback request · Approved CRM lead with valid contact permission.

### Lead intake channels

Three intake pipelines feed the lead queue, all producing the same internal `LeadReceived` event:

1. **Website/form webhooks** — signed endpoints registered per organisation (`webhook_endpoints`).
2. **Email enquiries** — the business designates a leads address (e.g. `enquiries@theirbusiness.com`) in its connected Microsoft 365 mailbox. The platform reuses the Module One Graph adapter (change notifications) to detect new inbound messages, and AI classification determines whether a message is a genuine new enquiry (versus spam, existing-customer thread, supplier, out-of-office). Only messages classified as new enquiries create leads; uncertain classifications go to a human review queue, never to the call queue.
3. **WhatsApp Business** — inbound messages to the organisation's WhatsApp Business number are received via the Meta WhatsApp Business Platform (Cloud API) webhook through the messaging-provider interface (Section 11). The message creates a lead with the sender's WhatsApp number as the callback number.

Intake is **receive-only** in the first implementation: the platform never initiates WhatsApp conversations or marketing template messages. Follow-up happens by phone call (and optionally by email reply). Automated WhatsApp replies may be considered as a later enhancement under Meta's messaging policies, and only with explicit approval.

### Dependency

This module reuses the voice infrastructure created in Module Two but requires separate consent rules, qualification flows, lead statuses, appointment booking, sales questions, follow-up timing and human-transfer logic. Credit-control conversation logic must never be reused as lead-sales logic.

**Entitlement dependency:** the Lead Follow-Up Agent requires the voice platform. Activating this module automatically activates shared voice infrastructure (billed as part of this module); it does not require the Voice Credit Controller module.

### Compliance requirements (mandatory)

Because lead follow-up is marketing-adjacent under PECR:

* Every lead must carry channel-appropriate consent evidence before any call is queued (see Consent evidence).
* Every number must be screened against the organisation's suppression list before dialling.
* The platform must provide a TPS/CTPS screening hook (manual attestation in v1; automated screening-service integration may follow). Note: a person who has directly enquired with the business (website form, WhatsApp message, email, missed call) has given the business a direct basis to respond to that enquiry; TPS/CTPS registration does not block responding to a genuine inbound enquiry, but the evidence must be stored and any subsequent "do not contact" request overrides everything, immediately and permanently.
* Calling hours default 08:00–21:00 UK time.
* Any "do not contact" request — made on a call, by email, or by WhatsApp message — is actioned immediately and permanently (suppression list), and applies across all channels.

### Example opening

"Hello, this is Eva, the AI assistant from ABC International. You recently requested information through our website about a kitchen renovation. Is now a convenient time to discuss your enquiry?"

### Lead qualification

Businesses configure approved questions. Example fields: required service, customer location, preferred timing, estimated budget, property type, job size, decision timeframe, availability, preferred appointment time, additional notes.

### Lead statuses

New · Contact queued · Calling · No answer · Contacted · Qualified · Not qualified · Appointment booked · Human callback required · Follow-up scheduled · Converted · Lost · Do not contact

### Speed-to-lead rules

Configurable response targets: immediately · within one minute · within five minutes · during business hours only · next business day · custom schedule. "Immediately" and minute-level targets must still respect permitted calling hours; leads arriving outside hours are queued for the next permitted window.

### Consent evidence

The system must store sufficient evidence showing why each lead is eligible to be contacted. For form submissions: form source, submission timestamp, consent text version, IP address where appropriate, website page, campaign source, callback request indicator and original enquiry reference. Consent text versions must be immutable records so evidence remains provable.

For non-form channels, the equivalent evidence is:

* **WhatsApp enquiries** — Meta message ID, sender WhatsApp number, business number, message timestamp and a copy of the initiating message content. An inbound message to the business constitutes the person initiating contact; the callback is a direct response to that enquiry.
* **Email enquiries** — Graph message ID, sender address, recipient address, subject, timestamp and thread reference, with the classification result that created the lead.
* **Missed inbound calls** — inbound call record (number, timestamp, call ID).

A lead without complete channel-appropriate evidence must never enter the call queue.

### Appointment booking

The agent should eventually support calendar integration. The first implementation may use internal availability slots, Google Calendar, Microsoft 365 Calendar or an external booking link. Calendar logic must be isolated behind the calendar-provider interface (Section 11). Conflicting bookings must be prevented by re-checking availability inside the booking transaction.

## 4.4 Module Four: AI Receptionist

### Purpose

The AI Receptionist answers incoming calls on behalf of the business, providing coverage during business hours, busy periods, after hours, weekends, staff absence and missed-call overflow.

### Why this phase is built fourth

The receptionist has the broadest conversation scope and therefore requires the most mature voice infrastructure, knowledge controls, call routing, human escalation, safety handling, business configuration, monitoring and failure recovery. It is built only after outbound voice workflows are stable.

### Example opening

"Hello, you have reached ABC International. I'm Eva, the company's AI receptionist. How may I help you today?"

### Core capabilities

Identify caller intent · Answer approved frequently asked questions · Capture new enquiries · Identify existing customers · Route invoice enquiries · Book appointments · Transfer urgent calls · Take structured messages · Provide opening hours · Provide service-area information · Handle basic status enquiries · Detect spam or abusive calls · Escalate uncertain requests · Update customer or lead records.

### Supported caller intents

New sales enquiry · Existing customer · Invoice or accounts query · Appointment request · Appointment change · Complaint · Emergency or urgent request · Supplier · Job applicant · General information · Wrong number · Spam · Human requested · Unknown

### Knowledge restrictions

The receptionist may answer only from approved business knowledge. It must not invent prices, availability, policies, guarantees, legal commitments, service coverage, technical advice or delivery dates. When information is unavailable, Eva must say so and arrange human follow-up.

Knowledge items are versioned records with an approval state; only approved versions are used. Knowledge management must guard against injection: content captured from callers or external text must never be written into approved knowledge without human approval.

### Call routing

Businesses must be able to define business hours, after-hours rules, staff members, departments, priority contacts, emergency numbers, transfer order, ring duration, fallback action and voicemail/message rules. If no human accepts a transfer, the configured fallback (message, callback, notification) must execute — the caller must never be left waiting indefinitely.

---

# 5. Modular Subscription Structure

Businesses activate one or more modules. Standard packages:

| Package | Modules included |
|---|---|
| Email Credit Controller | Module One only |
| Credit Controller Plus | Modules One + Two |
| Lead Assistant | Lead Follow-Up Agent only (voice platform included) |
| AI Receptionist | Module Four only |
| Sales Desk | Lead Follow-Up Agent + AI Receptionist |
| Complete Eva Suite | All four modules |

## Entitlement model

Module access is controlled by backend entitlements. Example:

```text
email_credit_controller = enabled
voice_credit_controller = disabled
lead_follow_up_agent = enabled
ai_receptionist = enabled
```

Frontend visibility alone is not sufficient security. Every protected backend action must verify: organisation, user, role, subscription, module entitlement, usage allowance and account status.

Entitlement dependencies: Lead Follow-Up Agent ⇒ voice platform active. AI Receptionist ⇒ voice platform active. Voice Credit Controller ⇒ Email Credit Controller data model present (not necessarily billed as a separate module when bundled).

## Usage allowances

Plans may control active invoices, monthly email reminders, connected mailboxes, monthly call minutes, phone numbers, lead volume, users, branches, data retention, operating hours, integrations and support level.

Usage is metered by the platform's own usage engine (Section 22), not by Paddle. Downgrading a plan must not delete historical data; the platform disables new activity beyond the new allowance while preserving records.

---

# 6. Target Customers

Initial target customers are UK microbusinesses and small businesses that lack dedicated credit-control staff, reception staff, lead-response staff or administrative support.

Potential sectors include construction, renovation, property maintenance, cleaning, recruitment, security services, courier and transport, marketing agencies, IT support, training businesses, consultants, wholesalers, professional services and local trades.

Initial positioning is B2B invoice collection (businesses chasing other businesses). See Section 17.6 for the consumer-credit perimeter note.

---

# 7. User Roles

## Organisation Owner

Manage subscription · Enable modules · Manage billing · Invite users · Configure integrations · Configure communication rules · Access all records · Export or delete organisation data.

## Administrator

Manage operational settings · Manage users where permitted · Configure workflows · Review activity · Manage templates · Handle escalations.

## Finance User

Manage customers · Manage invoices · Review credit-control activity · Mark payments · Handle disputes · Configure reminder sequences where permitted · Confirm AI-classified reply outcomes.

## Sales User

View and manage leads · Review lead calls · Manage appointments · Handle follow-ups.

## Reception User

Review inbound calls · Handle messages · View call routing · Complete callbacks.

## Read-Only User

View permitted information; cannot change records or initiate communication.

Role permissions must be enforced in the backend on every request, and role-permission unit tests are mandatory (Section 13).

---

# 8. Platform Architecture

The platform uses a modular monolith with strict internal boundaries, avoiding premature microservice complexity while preventing uncontrolled coupling.

## Repository structure

```text
apps/
  web/                  # Next.js 16 responsive web app (PWA-ready from Phase 5)
  api/                  # NestJS 11 backend API
  worker/               # Background workers (queue consumers, schedulers)

packages/
  ui/                   # Shared UI components (used by web; desktop in Phase 6)
  design-system/        # Tokens, Tailwind theme
  api-client/           # Typed API client generated from OpenAPI spec
  types/                # Shared TypeScript types and contracts
  validation/           # Shared validation schemas (zod)
  authentication/       # Auth helpers
  entitlements/         # Entitlement-check helpers
  configuration/        # Shared config handling
  testing/              # Test utilities and factories

modules/                # Backend business modules (inside apps/api, enforced boundaries)
  organisations/
  users/
  billing/
  entitlements/
  contacts/
  customers/
  invoices/
  email-credit-control/
  voice-credit-control/
  lead-follow-up/
  receptionist/
  communications/
  scheduling/
  integrations/
  notifications/
  audit/
  monitoring/

infrastructure/
  database/             # Migrations, seed
  docker/               # Dockerfiles, compose for local dev
  ci/                   # GitHub Actions workflows
  deployment/           # Environment configuration
```

The `apps/desktop` directory must not be created before Phase 6. No placeholder implementations.

## Architecture rules

Each module must:

* Own its business logic
* Expose clear service interfaces
* Avoid direct access to another module's internal implementation (cross-module access only via exported service contracts)
* Use shared contracts from `packages/types`
* Emit domain events where appropriate
* Have independent tests
* Have clear failure boundaries
* Avoid circular dependencies

## Prohibited architecture patterns

The Builder must not create:

* One oversized service file
* One universal controller or route handler
* One shared function containing unrelated business rules
* Duplicate payment-status logic
* Duplicate consent logic
* Duplicate scheduling logic
* Direct provider calls scattered throughout the codebase (all provider access via adapters in `modules/integrations`)
* Hidden cross-module state changes
* Business logic inside UI components
* Business logic inside database models
* Unvalidated provider payloads
* Unstructured error handling

---

# 9. Decided Technology Stack

> This section replaces all earlier "options" lists. These are decisions, not suggestions (Section 3.8).

## 9.1 Frontend

| Concern | Decision |
|---|---|
| Framework | Next.js 16 (App Router) |
| Language | TypeScript 5 (strict mode) |
| UI library | React 19 |
| Styling | Tailwind CSS v4 |
| Components | shadcn/ui (accessible, Radix-based) |
| Forms/validation | react-hook-form + zod |
| Data fetching | Typed API client from `packages/api-client` |
| Accessibility | WCAG 2.2 AA target |

## 9.2 Backend API

| Concern | Decision |
|---|---|
| Framework | NestJS 11 (Express 5 adapter) |
| Language | TypeScript 5 (strict mode) |
| API style | REST with OpenAPI (Swagger) spec generated from code; `packages/api-client` generated from that spec |
| Validation | class-validator/zod at the boundary; every payload validated |
| Runtime | Node.js 22 LTS |

## 9.3 Background processing

| Concern | Decision |
|---|---|
| Platform | Inngest (durable functions, scheduling, retries, event-driven) — self-hostable; Trigger.dev is the pre-approved fallback if Inngest proves unfit during Phase 0 |
| Scope | Reminder scheduling, send queues, retry processing, webhook processing, PDF extraction orchestration, notification fan-out |
| Prohibited | Celery, Python workers, Temporal, hand-rolled cron loops |

## 9.4 Database and storage

| Concern | Decision |
|---|---|
| Database | PostgreSQL 16+ on Supabase, **London region (eu-west-2)** |
| ORM | Prisma 7 |
| Tenant isolation | Application-layer scoping on every query **plus** Postgres Row Level Security policies as a second enforcement layer |
| Migrations | Prisma Migrate, forward-only with documented rollback notes per migration |
| Object storage | Supabase Storage (encrypted), invoices and documents only |

## 9.5 Authentication

| Concern | Decision |
|---|---|
| Provider | Supabase Auth (email/password + MFA support; organisation model implemented in application tables) |
| Session | HTTP-only secure cookies; short-lived access tokens; refresh rotation |
| Backend verification | NestJS guard validating Supabase JWT on every request |
| Removed options | Auth.js (maintenance mode), Clerk (US-only data residency) |

## 9.6 Email

| Concern | Decision |
|---|---|
| Customer mailbox sending | Microsoft Graph (multi-tenant app registration, OAuth, minimal scopes) |
| Platform transactional email (invites, alerts, auth-adjacent notices) | Resend behind the notifications module (Postmark is the pre-approved fallback) |

## 9.7 Voice

| Concern | Decision |
|---|---|
| Voice AI platform | **Vapi** (primary) — configured for recording/transcript retention disabled and UK data processing where offered; **Retell AI** is the pre-approved fallback |
| Telephony | Twilio UK geographic numbers |
| Integration | Behind the internal voice-provider interface (Section 11); selection confirmed by the Slice 2.1 spike |

## 9.8 Payments

| Concern | Decision |
|---|---|
| Provider | Paddle (Merchant of Record) — subscriptions, trials, upgrades/downgrades |
| Entitlements | Platform-internal entitlement engine is the source of truth; Paddle webhooks update it |
| Note | Paddle account approval must be obtained before launch (see Appendix A) |

## 9.9 AI

| Concern | Decision |
|---|---|
| Provider | OpenAI API (structured outputs) behind an internal AI adapter |
| Rules | Versioned prompts, deterministic validation of outputs, restricted tool access, cost and token monitoring, no training on customer data (API data-processing terms), organisation-level cost caps |

## 9.10 Monitoring and operations

| Concern | Decision |
|---|---|
| Error tracking | Sentry (API, worker, web) |
| Logs | Structured JSON logs with correlation IDs |
| Metrics/alerts | Platform metrics (Section 14) with alert rules; uptime monitoring on health endpoints |
| CI/CD | GitHub Actions: lint, typecheck, unit tests, build on every PR; staging deploy on merge; production deploy manual |
| Environments | dev (local, Docker Compose) · staging · production |
| Secrets | Platform environment-variable management (host/Supabase/GitHub Environments); `.env.example` committed; no secrets in source control |

## 9.11 Deployment

| Concern | Decision |
|---|---|
| Packaging | Docker containers for `api` and `worker`; local dev via Docker Compose |
| Hosting | Single PaaS host for api + worker (Railway, Render or Fly.io — select one in Phase 0 and record the choice); web on Vercel or the same host |
| Database | Supabase (managed), London region |
| Rollback | Every deployment and migration must have documented rollback guidance |

## 9.12 Desktop (Phase 6 only)

Tauri v2 (Rust shell) reusing `packages/ui` and `packages/api-client`; secure OS credential storage; signed builds; controlled automatic updates. See Section 21.

---

# 10. Core Data Model

The initial database should consider the following entities (all tenant-owned records carry an `organisation_id`; tenant isolation is enforced in application code and RLS, and must be tested):

**Identity and access:** organisations · organisation_settings (timezone, business hours, calling hours, locale) · users · organisation_memberships · roles · permissions

**Billing:** subscriptions · plans · entitlements · usage_records · invoices_platform (Eva's own billing records where needed)

**CRM core:** customers · contacts · communication_preferences · consent_records · consent_text_versions · suppression_list (channel: email/call; value; reason; created_at — permanent, never hard-deleted)

**Invoicing:** invoices · invoice_documents · invoice_payments · payment_promises · disputes

**Email credit control:** email_templates (versioned, with tone and approval state) · reminder_sequences · reminder_steps · scheduled_actions · email_accounts · email_messages · email_events (sent/delivered/bounced/replied/failed with provider metadata)

**Voice:** phone_numbers · calls · call_outcomes · voice_provider_configs

**Leads:** leads · lead_sources · webhook_endpoints (registered intake endpoints with signing secrets) · messaging_accounts (WhatsApp Business connections via `provider_connections`) · appointments

**Receptionist:** receptionist_rules · knowledge_items (versioned, approval state) · routing_rules

**Platform:** notifications · notification_preferences · human_escalations · provider_connections · audit_logs · domain_events · webhook_events · failed_jobs · idempotency_keys

Conventions: soft delete for business records; `created_at`/`updated_at`/`created_by` on all mutable records; monetary amounts as integer minor units (pence) with currency code (default GBP).

---

# 11. Integration Abstraction

External providers must be isolated behind internal interfaces in `modules/integrations`. Provider-specific code must never appear in business logic.

## Email provider interface

Connect account · Refresh authentication · Send message · Subscribe to mailbox changes · Retrieve reply metadata · Detect NDR/bounce messages · Attach invoice · Disconnect account · Check connection health.

## Voice provider interface

Initiate call · Accept inbound call · Transfer call · End call · Return structured outcome · Report usage · Report failure · Configure number · Verify recording-disabled configuration.

## Calendar provider interface

Retrieve availability · Create appointment · Update appointment · Cancel appointment · Check conflicts.

## Billing provider interface

Start checkout · Read subscription status · Process webhook (signature-verified) · Update entitlements · Record usage · Handle cancellation.

## AI provider interface

Classify reply · Classify call outcome · Adapt template tone · Extract invoice fields from document · Structured outputs only, with schema validation and confidence scores.

## Extraction provider interface

Extract fields from invoice PDF/CSV/Excel → return draft with per-field confidence. Initial implementation uses the AI provider; the interface keeps it swappable.

## Messaging provider interface (WhatsApp)

Receive inbound message webhook (signature-verified) · Normalise message to internal lead format · Report connection health · (Future, approval-gated: send reply within an open customer-service window). Implementation: Meta WhatsApp Business Platform (Cloud API). The organisation must own its WhatsApp Business number and Meta Business account; Eva acts as the connected app. No outbound marketing template messages.

---

# 12. Event-Driven Coordination

Modules communicate through defined domain events where appropriate. Example events:

InvoiceImported · InvoiceActivated · InvoiceBecameOverdue · EmailReminderScheduled · EmailReminderSent · EmailReminderFailed · EmailReplyReceived · EmailReplyClassified · EmailBounceDetected · PaymentPromiseRecorded · InvoiceDisputed · InvoiceMarkedPaid · VoiceCallRequested · VoiceCallCompleted · LeadReceived · LeadContactApproved · LeadQualified · AppointmentBooked · InboundCallReceived · HumanEscalationCreated · SubscriptionChanged · EntitlementUpdated · SuppressionAdded

Event handlers must be idempotent, retry-safe, observable, tested and protected against duplicate processing (idempotency keys; webhook deliveries deduplicated by provider event ID).

---

# 13. Testing Strategy

Testing is mandatory for every feature slice.

## Unit tests

Required for: due-date calculations (including timezone and DST boundaries) · invoice-state transitions · reminder eligibility · promise-to-pay logic · dispute logic · entitlement checks · consent rules · suppression checks · calling-hours rules · call-outcome actions · usage calculations · role permissions.

## Integration tests

Required for: database operations (including RLS tenant isolation) · Microsoft Graph adapter (mocked) · Paddle webhooks · Voice provider adapter · Queue processing · File storage · PDF extraction · Calendar integrations · Reply/NDR detection pipeline.

External APIs are mocked in automated tests. Sandbox environments (Microsoft 365 developer tenant, Paddle sandbox, Twilio test credentials, voice-provider test keys) are used for controlled integration testing.

## End-to-end tests

Critical journeys: sign up and create organisation · subscribe through Paddle · enable a module · import an invoice · confirm extracted invoice · schedule an email reminder · send through Outlook · receive and classify a reply · mark invoice paid · prevent further reminders · trigger credit-control call · record promise to pay · submit website lead · call lead · book appointment · receive inbound receptionist call · escalate to human.

## Security tests

Required: cross-tenant access attempts (application and RLS layers) · role-bypass attempts · invalid webhook signatures · OAuth token handling · secret leakage · injection attacks · file-upload validation · rate limiting · duplicate job execution · replay attacks · unauthorised module access.

## Failure tests

Required scenarios: Microsoft authentication expires · Email provider throttles (429) · Voice provider unavailable · Database connection fails · Queue retries a completed job · Paddle sends duplicate webhook · PDF extraction returns incorrect data · Customer is marked paid during job execution · Reply arrives for a paid invoice · NDR received · Call disconnects midway · AI returns invalid structured output · Calendar slot becomes unavailable · Organisation exceeds plan allowance · Clock changes across BST/GMT boundary during scheduling.

---

# 14. Monitoring and Observability

## Required logs

Every important operation includes: timestamp · environment · organisation ID · user ID where applicable · correlation ID · module · action · result · provider · error code · retry count. Sensitive personal or financial information must not be unnecessarily written to logs (no invoice amounts, no customer financial detail, no tokens).

## Required metrics

Emails scheduled/sent/failed · duplicate sends prevented · replies detected and classified · bounces detected · calls attempted/answered/failed · leads contacted · appointments booked · invoice promises recorded · queue depth · job latency · API response time · provider errors · active organisations · usage by module · AI cost · voice cost · email connection health · suppression-list size.

## Alerts

High email failure rate · voice provider failure · queue backlog · database errors · invalid billing webhooks · repeated authentication failures · tenant-isolation test failure · unexpected usage spike · high AI error rate · expiring provider credentials · mailbox disconnected · organisation approaching usage cap.

---

# 15. Security Requirements

The platform must implement:

* Encryption in transit (TLS everywhere) and at rest (database, storage, token stores)
* Secure secret management (Section 9.10); no production secrets in source control
* OAuth instead of mailbox-password storage; provider tokens encrypted at rest
* Multi-factor authentication support for users
* Role-based access control enforced in the backend on every request
* Tenant isolation in application code and Postgres RLS
* Input validation on every boundary; output encoding
* Rate limiting on public endpoints and webhook receivers
* Audit logging of all state-changing operations
* Signed webhook verification (Paddle, Graph, voice provider, lead intake)
* Secure file validation (type sniffing, size limits, malware-scanning hook) for uploads
* Dependency scanning in CI
* Security headers and controlled CORS
* Least-privilege provider permissions (minimal OAuth scopes)
* Safe token refresh with rotation
* Session expiration and account lockout protections
* Automated backups with tested recovery procedures (RPO ≤ 24h, RTO ≤ 8h for launch; tightened as the product matures)

---

# 16. Privacy Requirements

The platform must support data minimisation · privacy notices · consent evidence · data access requests · data correction · data deletion · organisation export · retention policies · contact suppression · do-not-call and do-not-email status · human-interaction requests · provider disclosure · subprocessor records.

The platform must not claim that avoiding recordings removes all privacy obligations.

---

# 17. UK Regulatory and Compliance Requirements

> This section is binding product behaviour, not legal advice. The business should obtain its own legal review before launch; these requirements encode the platform-side mechanics.

## 17.1 Roles under UK GDPR

Eva (the platform operator) is **data processor** for customer business data (invoices, contacts, leads, calls) and **data controller** for its own account and billing data. The platform must provide a Data Processing Agreement template, maintain a subprocessor register (Supabase, Microsoft, OpenAI, Vapi/Retell, Twilio, Paddle, Sentry, transactional-email provider), and prefer UK/EU processing regions wherever offered (Supabase London mandated; voice-provider UK residency configuration verified in Slice 2.1).

## 17.2 PECR and AI calling

* Fully automated/pre-recorded marketing calls require prior consent and are prohibited on this platform.
* Eva's calls are interactive and must always offer a human-handoff path.
* Lead follow-up calls require stored consent evidence (Section 4.3) — no consent, no call.
* Invoice-chasing calls to existing customers are service calls; lawful basis is contract/legitimate interest. Transparency duties still apply: Eva discloses she is an AI at the start of every call.
* Marketing-adjacent numbers must be screened against TPS/CTPS per Section 4.3.

## 17.3 Calling hours and frequency

Default permitted calling window: 08:00–21:00 UK local time, organisation-configurable only within that envelope. Frequency caps per Section 4.2. All scheduling evaluated in the organisation's timezone (Section 18.1).

## 17.4 Suppression lists

The suppression list is permanent and cross-module: any do-not-call/do-not-email request adds an entry that survives deletion of the originating lead, customer or invoice. Every import, reminder send and dial attempt re-checks the suppression list. Suppression entries are never hard-deleted.

## 17.5 Email rules

Invoice-reminder emails to existing customers about their own transactions are service communications. Every email must identify the business clearly and provide a valid reply path. Mass marketing email is a non-goal (Section 24). The web application must present cookie consent and load no non-essential cookies or analytics before consent.

## 17.6 Consumer-credit perimeter

The platform is positioned for B2B invoice collection. If an organisation chases consumers under regulated credit agreements, FCA CONC rules may apply to that organisation's activity. The platform must surface this guidance during Voice Credit Controller onboarding and must never itself threaten legal action, invent fees or apply pressure tactics (already prohibited in Section 4.2).

## 17.7 AI transparency

Every AI call begins with an explicit AI disclosure naming the calling business. The AI persona must never claim to be human. These are hard product rules with automated test coverage.

---

# 18. Non-Functional Requirements

## 18.1 Timezone and locale (mandatory model)

* All timestamps stored in UTC.
* All business logic (due dates, "due today", reminder windows, business hours, calling hours) computed in the organisation's configured timezone; default `Europe/London`.
* Server-local time must never be used in business logic.
* BST/GMT transitions covered by unit tests.
* Locale: en-GB; currency: GBP by default (£ formatting, minor-unit storage); date format DD/MM/YYYY in UI.
* English only at launch; no i18n framework required, but user-facing strings centralised to allow later localisation.

## 18.2 Environments

dev (local Docker Compose with seed data) · staging (mirror of production config, sandbox providers) · production. CI deploys to staging on merge; production deploys are manual and tagged.

## 18.3 Performance targets (launch)

* Dashboard p95 load < 2s · API p95 < 500ms · reminder send pipeline processes due reminders within 5 minutes of schedule · lead "immediate" calls initiated within 60 seconds of receipt during permitted hours.

## 18.4 Availability and recovery

Target 99.5% monthly availability at launch. Backups: automated daily (Supabase PITR where available); recovery tested at least once before launch. RPO ≤ 24h, RTO ≤ 8h.

## 18.5 Accessibility

WCAG 2.2 AA for the web application: keyboard navigation, focus management, contrast, form labels, error identification.

## 18.6 Seed and demo data

Phase 0 must include seed scripts creating a demo organisation with sample customers, invoices, templates and settings so every later slice is demonstrable without manual data entry. Demo data must be clearly flagged and excluded from any real sending.

---

# 19. Development Rules for the Builder

The Builder must follow these rules throughout development.

**Rule 1 — Do not build the whole product at once.** Work only on the currently approved feature slice.

**Rule 2 — Explain the purpose first.** Before coding, report: feature being built · why it is needed · dependencies · files expected to change · tests to be added · risks.

**Rule 3 — Keep changes small.** Avoid large unrelated refactors.

**Rule 4 — Preserve module boundaries.** Do not place module-specific logic in shared utilities merely for convenience.

**Rule 5 — Avoid overlapping functions.** Each function has one clear responsibility. Do not create multiple functions that independently change the same business state without a shared controlled service.

**Rule 6 — Prevent regression.** Before completing a feature: run new tests, run related existing tests, run linting, run type checking, run build, review affected modules.

**Rule 7 — Report honestly.** After every slice, report: what was implemented · what was not implemented · tests added · test results · files changed · database migrations · security considerations · monitoring added · known limitations · manual testing steps · recommended next slice.

**Rule 8 — Stop after every slice.** The Builder must wait for approval before starting the next feature.

**Rule 9 — Never silently change scope.** Any architectural, stack or scope change must be reported and approved before implementation. The decided stack in Section 9 is binding.

**Rule 10 — Make rollback possible.** Every database or infrastructure change must include rollback guidance.

**Rule 11 — No placeholder debt.** Do not scaffold future modules (voice, leads, receptionist, desktop) before their phase. Empty folders and stub services are prohibited.

**Rule 12 — Never invent requirements.** If this specification is silent on a decision the Builder needs, the Builder must stop and ask rather than guess, except where Section 9 already provides the decision.

---

# 20. Build Phases and Approval Gates

> One authoritative sequence: Phase 0 → 1 → 2 → 3 → 4 → 5 (PWA) → 6 (optional Tauri). This merges and supersedes the phase lists in v1.0 and the v1.1 amendment.

## Phase 0: Project Foundation

### Why this phase exists

To establish a safe, maintainable foundation without prematurely building future modules.

### Prerequisites (business tasks, not code)

Confirmed before or during Phase 0 (see Appendix A): GitHub organisation/repo · Supabase project (London region) · Microsoft 365 developer tenant · Paddle account application submitted · Sentry project · hosting account.

### Scope

* Repository structure per Section 8 (no `apps/desktop`)
* Environment configuration (dev/staging/prod) and secrets handling
* TypeScript strict configuration, formatting, linting
* Testing framework (unit + e2e scaffolding)
* Docker Compose local environment
* Database connection, Prisma 7, migration system, seed data
* Supabase Auth integration, organisation model, memberships, basic role model
* RLS tenant-isolation policies and tests
* Logging, error handling, correlation IDs, Sentry
* Health endpoint
* CI checks (lint, typecheck, test, build) and branch protection
* Base design system (`packages/design-system`, `packages/ui` shell)
* Inngest integration skeleton with one example durable function

### Approval gate

Do not continue until: build passes · lint passes · type checking passes · tests pass · organisation isolation demonstrated (app layer and RLS) · environment secrets excluded from source control · health endpoint works · architecture documented · seed data loads · staging deploys successfully.

---

## Phase 1: Email Credit Controller

Divided into smaller approved slices:

* **Slice 1.1: Customers and contacts** — records, organisation ownership, CRUD, validation, permissions, audit logging, suppression-list data structure.
* **Slice 1.2: Invoice records** — manual entry, statuses and state machine, due dates (timezone-aware), amounts (minor units), currency, customer relationship, validation, audit trail.
* **Slice 1.3: CSV and Excel import** — upload, column mapping, validation, duplicate detection, preview, confirmation, import report, suppression re-check.
* **Slice 1.4: PDF extraction** — secure upload, extraction adapter, draft result, confidence indicators, review screen, confirmation, failure handling.
* **Slice 1.5: Reminder sequence** — stages, eligibility rules, scheduling (org timezone), pause/resume, paid/disputed/suppressed exclusions, duplicate prevention with idempotency mechanism.
* **Slice 1.6: Outlook connection** — Microsoft OAuth, minimal permissions, encrypted token storage, refresh handling, disconnect, health status, test email.
* **Slice 1.7: Email sending** — approved templates, invoice variables, attachments, send queue with 429/backoff handling, retry rules, audit history, failure handling, safe sending defaults (Section 4.1).
* **Slice 1.8: Manual reply and status workflow** — manual outcome entry: promise to pay, dispute, invoice copy request, wrong contact, paid claim, human escalation.
* **Slice 1.9: Reply detection** — Graph change notifications, thread matching, AI classification with confidence, human confirmation for state changes, NDR/bounce detection, failing-address pause.
* **Slice 1.10: Dashboard and monitoring** — outstanding total, overdue total, reminder status, failed sends, promises to pay, disputes, activity timeline.

### Phase 1 approval criteria

No duplicate sends · paid invoices are not chased · disputed invoices are paused · suppressed contacts are never emailed · cross-tenant access is prevented (app + RLS) · Outlook disconnect is safe · retry and 429 behaviour is tested · reply detection classifies accurately on test set · bounces pause failing addresses · activity is auditable · monitoring is operational.

---

## Phase 2: Voice Credit Controller

* **Slice 2.1: Voice-provider spike and abstraction** — verify against Vapi: UK latency, recording/transcript retention disabled, UK data-processing configuration, structured outcome webhooks, Twilio UK number provisioning; document findings; build provider adapter; fall back to Retell AI if spike fails criteria.
* **Slice 2.2: Call eligibility and scheduling** — calling-hours guardrails, frequency caps, suppression checks, CLI presentation.
* **Slice 2.3: AI disclosure and contact verification**.
* **Slice 2.4: Controlled conversation workflow**.
* **Slice 2.5: Structured call outcome**.
* **Slice 2.6: Promise-to-pay actions** (with human verification for paid claims).
* **Slice 2.7: Dispute and human escalation**.
* **Slice 2.8: Voice usage, monitoring and cost controls** (per-organisation caps).

### Phase 2 approval criteria

Eva identifies herself as AI · invoice information is protected · audio is not retained (provider config verified) · full transcripts are not retained · structured outcomes are reliable · human escalation works · stop-contact requests enforced via suppression list · calling hours enforced · CLI presented · usage is measured · failed calls retry safely.

---

## Phase 3: Lead Follow-Up Agent

* **Slice 3.1: Lead data model** (including consent evidence and consent text versions for all intake channels).
* **Slice 3.2: Website webhook intake** (signed endpoints, `webhook_endpoints`).
* **Slice 3.2b: Email enquiry intake** — designated leads address, Graph change-notification detection, AI enquiry classification, human review queue for uncertain messages.
* **Slice 3.2c: WhatsApp Business intake** — Meta Cloud API webhook, signature verification, message-to-lead normalisation, health monitoring.
* **Slice 3.3: Consent evidence and TPS/CTPS screening hook** (manual attestation v1; per-channel evidence validation — no evidence, no call).
* **Slice 3.4: Rapid call scheduling** (respecting permitted hours).
* **Slice 3.5: Qualification scripts**.
* **Slice 3.6: Appointment booking** (calendar-provider interface; conflict-safe).
* **Slice 3.7: Human transfer and callback**.
* **Slice 3.8: Lead dashboard and reporting**.

### Phase 3 approval criteria

Only eligible leads are contacted · every lead traces to stored channel-appropriate consent evidence (form, email, WhatsApp or missed call) · a lead without complete evidence never enters the call queue · purchased cold lists are unsupported · uncertain email classifications go to human review, never to the call queue · TPS/CTPS handling follows Section 4.3 · qualification answers are structured · appointment conflicts are prevented · do-not-contact requests from any channel (call, email, WhatsApp) are enforced permanently and cross-channel · human escalation works · WhatsApp intake is receive-only with no outbound marketing messages.

---

## Phase 4: AI Receptionist

* **Slice 4.1: Inbound phone number** (Twilio, organisation-owned).
* **Slice 4.2: Business-hours routing**.
* **Slice 4.3: Caller-intent classification**.
* **Slice 4.4: Approved business knowledge** (versioned, approval-gated).
* **Slice 4.5: Message capture**.
* **Slice 4.6: New-enquiry creation**.
* **Slice 4.7: Appointment booking**.
* **Slice 4.8: Human transfer** (with guaranteed fallback).
* **Slice 4.9: After-hours and emergency rules**.
* **Slice 4.10: Receptionist dashboard**.

### Phase 4 approval criteria

Eva identifies herself as AI · approved knowledge is enforced · unknown answers are not invented · urgent calls are handled correctly · transfers and fallbacks work (caller never left waiting) · messages are accurately recorded · no audio or full transcripts retained · inbound usage is measured.

---

## Phase 5: Progressive Web App

After all required web workflows are stable: add installability · supported push notifications · application icons · offline status · safe limited caching · update testing · browser-compatibility testing.

### Known platform constraints (must be documented in-product)

* iOS: push notifications work only when the PWA is installed via Safari → Share → Add to Home Screen (iOS 16.4+); no automatic install prompt exists, so the UI must show install instructions; push delivery on iOS is less reliable than Android.
* No critical operation may depend on the service worker; automation continues in the cloud regardless.

### Phase 5 approval criteria

Installation works on supported browsers · standalone mode opens · authentication remains secure · updates apply safely · offline status is clear · no critical operation depends on the service worker · cached data respects tenant and user permissions · notifications do not expose sensitive information · web automation continues when the PWA is closed · iOS install guidance is shown where relevant.

---

## Phase 6: Optional Tauri Desktop Client

Build only after: PWA usage has been evaluated · customers demonstrate demand for a downloadable application · native features provide measurable value · desktop maintenance costs are justified · code-signing certificates are procured (Apple Developer account; Windows code-signing certificate).

### Architecture

Shared packages (UI, types, validation, API client, auth helpers, entitlement helpers) are reused. The Tauri client uses the same cloud API. It must not directly access the production database, must not contain a separate implementation of business logic, and must not become a dependency for cloud automation.

### Desktop client restrictions

The Tauri client must not independently send scheduled invoice emails · initiate scheduled customer calls · receive receptionist calls without the cloud service · process Paddle webhooks · refresh Microsoft provider tokens as the primary system · make authoritative invoice-status changes without the API · store the complete production database locally · store provider credentials in plain text · contain duplicated business rules.

### Authentication

System-browser OAuth flow with registered deep-link callback · short-lived access tokens · refresh-token rotation · secure OS storage (Windows Credential Manager, macOS Keychain, Linux Secret Service) · logout revokes local credentials. Never store sensitive authentication information in plain-text files, local JSON config, source code, logs or error messages.

### Offline behaviour

Clients may cache limited non-sensitive operational information (recent activity, invoice and lead summaries, pending callbacks, draft notes, previously loaded dashboard data). Cached information must be encrypted where appropriate, have a defined expiry, be cleared on logout where required, not bypass permissions and not be treated as authoritative. Offline banner:

> **Offline — your Eva automations continue securely in the cloud. Some dashboard information may not be current.**

Users may prepare safe draft actions offline; all actions are revalidated by the backend when connectivity returns.

### Native notifications

Allowed for: new inbound lead · lead requires human follow-up · customer promised payment · invoice disputed · customer claims payment · mailbox connection failed · call transfer requested · urgent message captured · provider reconnection required · subscription/usage warning. Notifications must not reveal financial or personal detail on a locked device (safe example: "Eva: An invoice follow-up requires your attention."). Users can configure notification categories.

### Human call handoff

The cloud voice service owns call execution and routing. The desktop client may show a transfer request and allow an authorised user to accept, decline, redirect, request a callback, view minimum context and mark completion. If the client is closed or unreachable, the cloud platform applies the configured fallback (transfer to business telephone, another user, message, callback, notification, after-hours rules).

### Build slices

* **6.1 Desktop shell** — Tauri app, shared UI integration, dev environment, secure configuration, API connectivity, basic signed test build.
* **6.2 Desktop authentication** — system-browser login, deep-link callback, secure token storage, logout, session expiry, token refresh.
* **6.3 System tray** — open dashboard, connection status, pause local notifications, sign out, quit. Quitting must not stop cloud automation.
* **6.4 Native notifications** — permissions, safe content, preferences, deep links.
* **6.5 File handling** — drag-and-drop invoices, validation, secure upload, progress, failure handling. Local files not retained longer than required.
* **6.6 Human handoff** — transfer alert, accept/decline, callback request, fallback behaviour, minimum caller context.
* **6.7 Automatic updates** — signed update packages, verification, safe rollout, failed-update recovery, version reporting.

### Desktop testing requirements

Windows installation · macOS installation if supported · application update · deep-link authentication · secure token storage · logout and token removal · expired-session handling · API connection loss · reconnection · notification permissions · locked-screen notification privacy · file upload · invalid file rejection · app closed during upload · handoff while app open · handoff while app closed · cloud automation while desktop offline · cross-tenant access attempts · application tampering checks · update-signature failure · WebView2 bootstrapper behaviour on Windows.

### Desktop monitoring

Limited operational diagnostics only: app version, OS, connection state, update state, authentication failures, API errors, notification failures, upload failures, crash information. Must not collect customer invoice contents, call audio, complete lead information, permanent tokens or sensitive local filenames where avoidable.

---

# 21. Additional Delivery-Channel Rules

* **Do not build local-first architecture.** The application remains cloud-first.
* **Do not duplicate backend logic.** Web, PWA and Tauri clients use the same backend APIs.
* **Do not make desktop mandatory.** Customers can use Eva fully through the web platform.
* **Do not let client closure interrupt automation.** Email, voice, lead and receptionist operations continue without an active client.
* **Share reusable frontend code deliberately.** UI components, types, validation and API clients may be shared; do not force sharing where platform-specific behaviour requires separation.
* **Secure native capabilities.** Every Tauri capability uses an explicit allowlist and least-privilege permissions.
* **Treat updates as a security feature.** Desktop update packages must be signed and verified.
* **Test platform differences.** Do not assume behaviour that works on Windows automatically works on macOS or Linux.

---

# 22. Commercial and Billing Requirements

Paddle handles SaaS subscription payments as Merchant of Record (it collects and remits VAT; receipts display Paddle's name — set this expectation in onboarding).

The platform must support monthly plans · annual plans · trials · setup fees · module upgrades · module downgrades · usage-based allowances · failed payments · grace periods · cancellations · refund-status updates · webhook replay safety.

The **platform's entitlement engine is the source of truth** for module access and usage allowances. Paddle webhooks update entitlements; usage metering is internal (Paddle is not used for metered billing).

Billing prerequisites: Paddle account approval must be obtained before launch (application early — see Appendix A); sandbox configured in Phase 0–1 for webhook testing.

---

# 23. Managed Setup Option

The platform may offer a managed onboarding service that includes Microsoft 365 mailbox guidance · dedicated accounts email setup · domain connection assistance · SPF/DKIM/DMARC setup · Outlook OAuth connection · invoice import · reminder-template setup · test communication · phone-number setup · lead-form integration · receptionist configuration.

The client should own its domain, its Microsoft tenant, its mailbox, its telephone number where possible and its business data. Eva must not store permanent Microsoft administrator passwords.

---

# 24. Initial Non-Goals

The first product is not intended to provide:

* Full accounting, VAT returns, bookkeeping or bank reconciliation
* Legal debt collection or court-action automation
* Card-payment collection by voice
* Cold-call prospecting or purchased-list dialling
* Mass marketing email
* WhatsApp marketing broadcasts, bulk messaging or outbound template campaigns (WhatsApp is an inbound enquiry channel only)
* Free-form AI-drafted customer emails (approved templates only)
* Full CRM replacement
* Payroll or employee monitoring
* Call recording or permanent transcript storage
* A native mobile application
* Multi-currency invoicing (GBP-first) or multi-language UI (en-GB first)

---

# 25. Success Metrics

## Email Credit Controller

Percentage of reminders successfully sent · reduction in overdue invoices · amount collected after reminders · promise-to-pay rate · dispute-detection rate · duplicate-send rate (target zero) · failure rate · reply-classification accuracy.

## Voice Credit Controller

Answer rate · correct-contact rate · promise-to-pay rate · human-escalation rate · cost per completed outcome · call-failure rate.

## Lead Follow-Up

Speed to first contact · answer rate · qualification rate · appointment-booking rate · lead-to-customer conversion · cost per qualified lead.

## AI Receptionist

Calls answered · missed-call reduction · successful routing · messages captured · appointments booked · human-transfer rate · unresolved-intent rate.

---

# 26. Definition of Done

A feature is not complete merely because it works once. A feature is complete only when:

* Code is implemented
* Architecture boundaries are respected
* Validation exists
* Permissions are enforced (app layer and RLS)
* Unit tests pass
* Integration tests pass where applicable
* End-to-end flow is tested where applicable
* Error states are handled
* Logs are present
* Metrics are present
* Documentation is updated
* Migration is documented
* Rollback is documented
* Security has been reviewed
* Manual test instructions are supplied
* Known limitations are reported
* Approval has been received

---

# 27. First Instruction to the Builder

The Builder must begin only with **Phase 0: Project Foundation**.

Before writing code, the Builder must produce:

1. Proposed repository structure (per Section 8).
2. Confirmation of the decided stack (Section 9) — including the one open Phase 0 choice: hosting provider (Railway, Render or Fly.io) with a one-paragraph justification.
3. Explanation of why the stack fits the product.
4. Module-boundary design.
5. Initial database approach (Prisma 7 + Supabase Postgres + RLS).
6. Testing approach.
7. Monitoring approach.
8. Security baseline.
9. Exact scope of the first small feature slice.
10. Files expected to be created.
11. Risks and assumptions.

The Builder must not begin Phase 1 until Phase 0 has been reviewed and approved. The Builder must not begin voice, leads or receptionist functionality during the foundation or email phases. The platform grows through controlled, tested and approved increments rather than speculative implementation.

---

# Appendix A — Pre-Build Business Checklist

External accounts and approvals with lead times. None of these block Phase 0 coding, but several block specific slices and launch; start them early.

| Item | Needed by | Notes |
|---|---|---|
| GitHub organisation and repository | Phase 0 | Branch protection on from day one |
| Supabase project — London (eu-west-2) region | Phase 0 | Database, Auth, Storage in one project |
| Hosting account (Railway / Render / Fly.io — pick one) | Phase 0 | Docker deploys for api + worker |
| Sentry project | Phase 0 | DSNs for web, api, worker |
| Microsoft 365 developer tenant + app registration | Slice 1.6 | Multi-tenant app, minimal Graph scopes; sandbox mailboxes for testing |
| Paddle account application | Submit during Phase 0 | Approval takes days; AI-category products may face extra review. Required before any real billing |
| Paddle sandbox | Slice 1.6–1.7 era (billing slice) | Webhook signature testing |
| Resend (or Postmark) account | Slice 1.7 | Platform transactional email |
| OpenAI API account (business/API terms, no-training) | Slice 1.4 | Structured extraction and classification |
| Twilio account with UK number capability | Phase 2 | Identity verification required; UK geographic numbers |
| Vapi account (+ Retell AI evaluation account) | Phase 2, Slice 2.1 | Verify recording-disabled configuration and UK data processing |
| Meta Business account + WhatsApp Business Platform (Cloud API) app | Phase 3, Slice 3.2c | Organisation owns its number and Meta Business account; business verification can take days–weeks, start early |
| Domain + DNS access (eva product domain) | Phase 1 | Transactional email authentication (SPF/DKIM/DMARC) |
| DPA + subprocessor register templates | Before first paying customer | UK GDPR processor obligations |
| TPS/CTPS attestation process (manual v1) | Phase 3 | Screening-service integration may follow |
| Apple Developer account + Windows code-signing certificate | Phase 6 only | Required for signed desktop builds and auto-updates |

---

# Appendix B — Glossary

* **NDR** — Non-Delivery Report; a bounce message received by the sending mailbox.
* **CLI** — Calling Line Identity; the caller ID presented on outbound calls.
* **TPS / CTPS** — (Corporate) Telephone Preference Service; UK opt-out registers for unsolicited marketing calls.
* **PECR** — Privacy and Electronic Communications Regulations; UK rules for electronic marketing, calls and cookies.
* **RLS** — Postgres Row Level Security; database-enforced tenant isolation.
* **MoR** — Merchant of Record; Paddle's role as the legal seller handling VAT and payment compliance.
* **DPA** — Data Processing Agreement.
* **DST** — Daylight Saving Time (BST/GMT transitions in the UK).

---

*End of consolidated specification v1.2.*
