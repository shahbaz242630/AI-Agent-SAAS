-- Slice 3.1b — migration 0029: the front door, and everything that arrives at it.
--
-- Ruling 29: Lead Follow-up by Email is ONE MAILBOX IN AND A REPLY OUT. The
-- business puts one address on their website and on their lead forms, and every
-- enquiry from everywhere lands there. This migration is that address.
--
-- ⚠️ THE ADDRESS IS ONE WE OWN, NOT THE CUSTOMER'S (ruling 25). Reading a Gmail
-- inbox is a *restricted* scope on Google's own classification — a CASA
-- assessment every 12 months, 4–12 weeks to approval, a 100-user cap until it
-- clears. Sending is merely *sensitive*. So mail comes TO us and the reply goes
-- FROM them, and no customer is ever asked for a permission we cannot afford.
--
-- Two tables, and they are deliberately different kinds of thing:
--
--   `inbound_addresses`  — WHERE a customer's enquiries land. One per
--                          organisation, never reissued.
--   `inbound_messages`   — WHAT arrived there. Written before anything is
--                          decided about it.
--
-- ⚠️ THE SECOND TABLE EXISTS SO THAT NOTHING IS EVER LOST BETWEEN THE DOOR AND
-- THE BOOK. Resend's `email.received` webhook carries METADATA ONLY — no body,
-- no headers, no attachments — so turning an arrival into a lead takes a second
-- network call that can fail on its own. Without a row written at the moment of
-- arrival, a failed fetch is an enquiry that no longer exists anywhere: the
-- customer's own mailbox never saw it, because it was forwarded to us.
--
-- A front door that drops what it cannot parse is the same defect as replying
-- to spam, pointing the other way.

-- ---------------------------------------------------------------------------
-- inbound_addresses — the front door
-- ---------------------------------------------------------------------------
--
-- Founder rulings 33 and 34 (2026-08-21), and both are visible in this table's
-- shape:
--
--  33. THE ADDRESS IS A READABLE BUSINESS SLUG PLUS A SHORT RANDOM TAIL —
--      `smith-plumbing-7k2fq9@…`. Real enquirers read this off a website and
--      type it, so it cannot be a random string; but anyone who can guess it
--      can push fake enquiries into a competitor's lead book, and Eva may one
--      day answer them in that customer's name. The tail is what stops that.
--
--  34. IT STARTS ON RESEND'S FREE `*.resend.app` DOMAIN and moves to a domain
--      we own before the first sale. That is why `domain` is a COLUMN and not a
--      constant: moving is then an UPDATE over a handful of rows, not a
--      re-derivation of every address we ever issued.

CREATE TABLE "inbound_addresses" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    -- The whole address, lowercased. THE identity of this row: it is what the
    -- webhook arrives carrying and the only key we can route an arrival on.
    "address" TEXT NOT NULL,
    -- The two halves, stored rather than parsed back out. `local_part` is the
    -- part that identifies the customer; `domain` is ours and will change once
    -- (ruling 34).
    "local_part" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID,
    -- Revoking an address (it leaked, it is being spammed) is a soft delete,
    -- and a NEW row is issued. See the unique index below for why the old one
    -- can never come back.
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "inbound_addresses_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "inbound_addresses_organisation_id_idx"
  ON "inbound_addresses"("organisation_id");

-- ⚠️ UNIQUE ACROSS EVERY ROW, INCLUDING REVOKED ONES — NOT A PARTIAL INDEX.
-- This is the difference between a revoked address being dead and a revoked
-- address being *somebody else's*. The address lives on a website, in a lead
-- form's settings and in the address books of everyone who ever enquired;
-- revoking it here does not reach any of those. If it could be reissued, mail
-- meant for the business that gave it up would be delivered, in full, into a
-- stranger's lead book — and would look exactly like a genuine enquiry.
--
-- An address we have ever issued is spent forever.
CREATE UNIQUE INDEX "inbound_addresses_address_key"
  ON "inbound_addresses"("address");

-- One LIVE front door per organisation (ruling 29: "one email address"). This
-- one IS partial: revoking and reissuing has to be possible, and the row above
-- is what keeps the old one dead.
CREATE UNIQUE INDEX "inbound_addresses_organisation_id_live_key"
  ON "inbound_addresses"("organisation_id")
  WHERE "deleted_at" IS NULL;

ALTER TABLE "inbound_addresses"
  ADD CONSTRAINT "inbound_addresses_organisation_id_fkey"
    FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  -- ⚠️ CASE-FOLDING IS A DATABASE FACT, NOT A SERVICE HABIT. The local part of
  -- an address is case-SENSITIVE in RFC 5321, but no real mail system treats it
  -- that way, and a webhook will hand us whatever the sender's client typed. We
  -- store and route on lowercase only, so `Smith-Plumbing-7k2fq9@…` and
  -- `smith-plumbing-7k2fq9@…` are the same door. Enforced here so that a
  -- service that forgets to lowercase fails loudly on INSERT rather than
  -- quietly issuing a second, unroutable address.
  ADD CONSTRAINT "inbound_addresses_lowercase_check"
    CHECK ("address" = lower("address")),
  -- The halves and the whole cannot disagree. Cheap, and it means anything
  -- reading `local_part` can trust it without re-parsing `address`.
  ADD CONSTRAINT "inbound_addresses_parts_check"
    CHECK ("address" = "local_part" || '@' || "domain"),
  -- ⚠️ TYPEABLE, BY CONSTRAINT. Ruling 33 only works if a human can read the
  -- address off a website and type it correctly: lowercase letters, digits and
  -- single hyphens, starting and ending on something that is not a hyphen. No
  -- dots (they are how Gmail aliasing surprises people), no plus signs (they
  -- are how filters get stripped), nothing that needs quoting.
  ADD CONSTRAINT "inbound_addresses_local_part_check"
    CHECK ("local_part" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length("local_part") BETWEEN 3 AND 64),
  ADD CONSTRAINT "inbound_addresses_domain_check"
    CHECK ("domain" ~ '^[a-z0-9]+([.-][a-z0-9]+)*\.[a-z]{2,}$');

-- ---------------------------------------------------------------------------
-- inbound_messages — what actually arrived
-- ---------------------------------------------------------------------------
--
-- ⚠️ WRITTEN AT THE MOMENT OF ARRIVAL, BEFORE ANYTHING IS DECIDED. The order is
-- load-bearing: record, then fetch the body, then derive a lead. Reverse it and
-- a failure anywhere in the chain loses an enquiry silently, because the
-- forwarded copy is the ONLY copy — the customer's own mailbox is not where we
-- read it from.
--
-- ⚠️ THIS IS NOT EVIDENCE, AND IT IS NOT APPEND-ONLY. `lead_evidence` is the
-- record PECR expects us to be able to show, and migration 0026 takes UPDATE
-- and DELETE away from it for that reason. This table is the working record of
-- a delivery — it gets a body written into it after the fact and a status that
-- moves — so it keeps UPDATE. Do not confuse the two: if anything here ever
-- starts being cited as proof that somebody made contact, it belongs in
-- `lead_evidence` instead.

CREATE TABLE "inbound_messages" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "inbound_address_id" UUID NOT NULL,
    -- Which service delivered it to us. One value today; ruling 34's move to a
    -- domain we own may or may not keep Resend behind it, and Cloudflare Email
    -- Routing is the named alternative.
    "provider" TEXT NOT NULL DEFAULT 'resend',
    -- ⚠️ THE IDEMPOTENCY KEY, AND THE REASON THIS TABLE IS NOT OPTIONAL.
    -- Webhooks retry. Resend will deliver the same `email.received` again on any
    -- non-2xx, on a timeout, and sometimes on a success it did not hear about —
    -- so "a lead per webhook call" is "a duplicate enquiry per network blip".
    -- The unique index below is what makes the second delivery a no-op.
    "provider_message_id" TEXT NOT NULL,
    -- The sender's own RFC 5322 Message-ID. Not our key — it is chosen by the
    -- sender and a forwarder may rewrite it — but it is what a reply has to
    -- quote in In-Reply-To to thread, so it is worth keeping.
    "rfc_message_id" TEXT,
    "from_address" TEXT NOT NULL,
    -- Which of our addresses it was delivered to, verbatim as the provider
    -- reported it. Kept alongside the resolved `inbound_address_id` because the
    -- two disagreeing is exactly the kind of routing bug that is invisible
    -- without both halves written down.
    "delivered_to" TEXT NOT NULL,
    "subject" TEXT,
    "text_body" TEXT,
    "html_body" TEXT,
    -- ⚠️ THE HEADERS ARE NOT DECORATION — THEY ARE THE LOOP-STOPPER (ruling 32).
    -- `Auto-Submitted`, `Precedence: bulk` and `List-*` are how we will know not
    -- to answer another machine, and answering another auto-responder is a loop
    -- that runs on the CUSTOMER'S domain, in the customer's name. They are
    -- stored from this migration onward — before the rules that read them exist
    -- — because a header not captured at arrival cannot be recovered later.
    "headers" JSONB,
    -- received | converted | ignored | failed. Only states that can actually
    -- occur, per the `ends_at` warning in migration 0024:
    --   received  — the webhook landed and the row was written. The resting
    --               state only while the body fetch is in flight.
    --   converted — a lead exists; `lead_id` names it.
    --   ignored   — deliberately not converted. Today that means the
    --               organisation no longer holds `lead_follow_up_email`: the
    --               address outlives the entitlement, so mail can arrive for a
    --               product nobody is paying for.
    --   failed    — the fetch or the conversion threw. `failure_reason` says
    --               what, and the row is what makes a retry possible.
    "status" TEXT NOT NULL DEFAULT 'received',
    "failure_reason" TEXT,
    "lead_id" UUID,
    -- ⚠️ THEIR CLOCK, NOT OURS — the same rule as `leads.received_at`. When the
    -- enquiry arrived at our door, from the provider's own record, because
    -- speed-to-lead is measured from when the person made contact.
    "received_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "inbound_messages_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "inbound_messages_organisation_id_idx"
  ON "inbound_messages"("organisation_id");

-- The queue a retry reads, and the queue a human review screen will read.
CREATE INDEX "inbound_messages_organisation_id_status_idx"
  ON "inbound_messages"("organisation_id", "status", "received_at" DESC);

-- ⚠️ THE DUPLICATE GUARD. Scoped by provider because ids are only unique within
-- the service that issued them.
CREATE UNIQUE INDEX "inbound_messages_provider_message_key"
  ON "inbound_messages"("provider", "provider_message_id");

ALTER TABLE "inbound_messages"
  ADD CONSTRAINT "inbound_messages_organisation_id_fkey"
    FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "inbound_messages_inbound_address_id_fkey"
    FOREIGN KEY ("inbound_address_id") REFERENCES "inbound_addresses"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  -- ⚠️ SET NULL, NOT CASCADE. Deleting a lead must not erase the fact that the
  -- message arrived — that is the audit trail of the door itself, and a message
  -- whose lead is gone is precisely the thing somebody will need to look at.
  ADD CONSTRAINT "inbound_messages_lead_id_fkey"
    FOREIGN KEY ("lead_id") REFERENCES "leads"("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "inbound_messages_provider_check"
    CHECK ("provider" IN ('resend')),
  ADD CONSTRAINT "inbound_messages_status_check"
    CHECK ("status" IN ('received', 'converted', 'ignored', 'failed')),
  -- A converted message names its lead, and nothing else may. Without this the
  -- status and the foreign key can disagree, and "how many enquiries did we
  -- turn into leads" gets two different answers depending which you count.
  ADD CONSTRAINT "inbound_messages_converted_check"
    CHECK (("status" = 'converted') = ("lead_id" IS NOT NULL)),
  -- A failure that does not say why is a failure nobody can act on.
  ADD CONSTRAINT "inbound_messages_failure_reason_check"
    CHECK ("status" <> 'failed' OR "failure_reason" IS NOT NULL);

-- ---------------------------------------------------------------------------
-- Tenant isolation (migration 0008's shape, unchanged)
-- ---------------------------------------------------------------------------

ALTER TABLE inbound_addresses ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbound_addresses FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON inbound_addresses
  USING (organisation_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (organisation_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

ALTER TABLE inbound_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbound_messages FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON inbound_messages
  USING (organisation_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (organisation_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

-- ---------------------------------------------------------------------------
-- ⚠️ The one read that happens BEFORE a tenant is known
-- ---------------------------------------------------------------------------
--
-- An inbound webhook is the only request in the system that arrives with no
-- organisation attached to it. All it carries is the address the mail was
-- delivered to; resolving THAT to an organisation is what makes every
-- subsequent query tenant-scoped. It is the same problem the login path has
-- (auth_user_id -> users.id, migration 20260722173000) and it gets the same
-- answer: its own narrow policy, SELECT-only, keyed to a dedicated GUC, failing
-- closed when the context is missing.
--
-- ⚠️ NOTE WHAT THIS POLICY CANNOT DO. It matches one row by exact address, so a
-- caller must ALREADY KNOW the address to read anything at all — it cannot list
-- addresses, cannot walk from one organisation to another, and returns nothing
-- when the GUC is unset. The webhook knows the address because the mail was
-- delivered to it; nobody else has a reason to.
CREATE POLICY inbound_address_routing ON inbound_addresses
  FOR SELECT
  USING (
    "deleted_at" IS NULL
    AND "address" = NULLIF(current_setting('app.current_inbound_address', true), '')
  );

-- ---------------------------------------------------------------------------
-- Runtime grants
-- ---------------------------------------------------------------------------
--
-- Migrations 0014–0016 removed every default privilege, so a new table starts
-- with NO grants at all. These lines are load-bearing: omit one and every query
-- against that table fails at runtime.

-- UPDATE is for revoking (a soft delete) and for ruling 34's domain move.
GRANT SELECT, INSERT, UPDATE ON inbound_addresses TO eva_app;

-- UPDATE is how the body arrives: the row is written from the webhook's
-- metadata, then filled in once the message itself has been fetched.
GRANT SELECT, INSERT, UPDATE ON inbound_messages TO eva_app;

-- ⚠️ THE REVOKE IS THE RULE; THE GRANT ABOVE DOES NOTHING ON ITS OWN.
-- `ALTER DEFAULT PRIVILEGES FOR ROLE eva` hands `eva_app` all four privileges
-- on every table `eva` creates (see `pg_default_acl`), and a GRANT only ever
-- ADDS. Migration 0026 shipped a confident comment about immutability with
-- UPDATE still sitting there from the default; migration 0028 re-asserted the
-- same REVOKE for the same reason. Stating it is not enforcing it.
--
-- Nothing here may be deleted. A door we issued and the mail that came through
-- it are the record of how a lead came to exist; a tidy-up script that removes
-- either leaves a lead whose origin cannot be explained.
REVOKE DELETE ON inbound_addresses FROM eva_app;
REVOKE DELETE ON inbound_messages FROM eva_app;
