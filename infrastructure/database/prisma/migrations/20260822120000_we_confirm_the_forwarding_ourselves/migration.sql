-- Slice 3.1b — migration 0031: we confirm the forwarding, so nobody hunts for a code.
--
-- Step 4 of the mailbox decision document. A customer on Gmail cannot hand us
-- their inbox — reading it is a RESTRICTED scope, an audit every twelve months
-- (ruling 25) — so they forward it instead. Google guards that with a
-- confirmation email sent TO THE FORWARDING ADDRESS, which is ours. We can read
-- it, so we can answer it, and the customer never sees a code at all.
--
-- ⚠️ THAT CONFIRMATION EMAIL IS THE ONLY THING STANDING BETWEEN A GUESSED
-- ADDRESS AND SOMEBODY ELSE'S LEAD BOOK, AND THIS MIGRATION IS BUILT AROUND NOT
-- THROWING IT AWAY.
--
-- Ruling 33 sized the random tail on the premise that a guessable address lets
-- an attacker push fabricated enquiries into a competitor's book — and once Eva
-- answers (3.1c), those get answered in that customer's name. Google's
-- confirmation step is the second lock on that door: mail cannot be forwarded
-- to an address until that address's owner agrees. We are the owner.
--
-- So "confirm it for them automatically" cannot mean "confirm anything that
-- asks". Confirming unconditionally would hand an attacker who guesses one
-- address a permanent, silent feed into that customer's book — and, from 3.1c,
-- a way to make Eva write to strangers over that customer's own signature.
--
-- The rule this migration encodes: WE CONFIRM WHAT THE CUSTOMER ASKED FOR, AND
-- WE ASK ABOUT ANYTHING ELSE.
--
--   `inbound_addresses.forwarding_armed_at` — the customer stood at the guided
--       screen and said "I am setting this up now". A short window.
--   `inbound_forwarding_requests`           — every confirmation email that has
--       ever arrived, what it asked for, and what we did about it.
--
-- An unexpected request is not dropped and is not confirmed. It is recorded and
-- shown to the customer, which is the only honest answer: we cannot tell a
-- customer who set forwarding up in another tab from an attacker who guessed,
-- but THEY can.

-- ---------------------------------------------------------------------------
-- The armed window
-- ---------------------------------------------------------------------------
--
-- ⚠️ A WINDOW, NOT A FLAG. A permanent "this customer allows forwarding" switch
-- is the unconditional confirm wearing a checkbox: set once during setup, it
-- would still be open a year later when somebody guesses the address. What we
-- actually know is far narrower and expires — that a signed-in user carrying
-- `leads:read` was on the guided screen a few minutes ago, about to type our
-- address into Gmail.
--
-- ⚠️ IT DELIBERATELY OUTLASTS THE ROUND TRIP BY A LONG WAY. Gmail sends its
-- confirmation the moment the address is entered, but the first real inbound
-- message of this slice took 1m52s to reach our webhook (2026-08-21), and a
-- customer reading instructions, finding Gmail's settings and typing an address
-- takes longer than either. The length of the window is measured in the
-- service, not here, so that changing it is a code change with a test rather
-- than a migration.

ALTER TABLE "inbound_addresses"
  ADD COLUMN "forwarding_armed_at" TIMESTAMPTZ(6),
  -- Who armed it. Not decoration: an unexpected confirmation is answered by a
  -- human, and "which of us was setting this up" is the first question asked.
  ADD COLUMN "forwarding_armed_by" UUID;

-- ---------------------------------------------------------------------------
-- inbound_forwarding_requests — who asked to forward mail here, and what we did
-- ---------------------------------------------------------------------------

CREATE TABLE "inbound_forwarding_requests" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    -- The door somebody asked to have mail delivered through.
    "inbound_address_id" UUID NOT NULL,
    -- ⚠️ THE CONFIRMATION EMAIL ITSELF, AND THE IDEMPOTENCY KEY. Webhooks retry
    -- and Gmail resends; `inbound_messages` already refuses a duplicate
    -- delivery, so keying this row to that one means a replay updates nothing
    -- rather than asking the customer the same question twice.
    "inbound_message_id" UUID NOT NULL,
    -- The mailbox that wants to forward — read out of Google's own message, not
    -- from the envelope sender, which is `forwarding-noreply@google.com` for
    -- every request from every account on earth and so identifies nobody.
    "source_address" TEXT NOT NULL,
    -- ⚠️ BOTH HALVES ARE KEPT, AND THE SECOND ONE IS WHAT KEEPS THIS FEATURE
    -- HONEST. Google's message carries a numeric code AND a verification link.
    -- We answer with the link; if that ever stops working — a changed URL
    -- shape, a Google-side step we will not follow — the code is what lets the
    -- screen say "paste this into Gmail" instead of leaving a customer stuck at
    -- a step they cannot see. A feature that degrades to three clicks is still
    -- a feature; one that degrades to silence is a support queue.
    "confirmation_code" TEXT,
    "confirmation_url" TEXT,
    -- pending | confirmed | declined. Deliberately NO 'failed':
    --   pending   — nobody has answered it yet. Either it arrived unarmed and
    --               is waiting for the customer, or our own attempt did not
    --               work and `failure_reason` says why. A failed attempt does
    --               not settle anything: the request is still open, the code is
    --               still valid, and the customer can still finish it by hand.
    --   confirmed — Google accepted the confirmation. Mail now flows.
    --   declined  — a human said it was not them. Terminal, and the reason this
    --               table exists at all.
    "status" TEXT NOT NULL DEFAULT 'pending',
    -- Why our own attempt did not work, if one was made. Present on a pending
    -- row; that combination is the fallback state, not a contradiction.
    "failure_reason" TEXT,
    "settled_at" TIMESTAMPTZ(6),
    -- ⚠️ NULL MEANS WE DID IT, NOT THAT NOBODY DID. A settled row with no user
    -- was confirmed automatically inside the armed window; a settled row with
    -- one was answered by a person on the guided screen. The screen says which,
    -- because "Eva confirmed this for you" and "you confirmed this" are
    -- different facts about the customer's own security.
    "settled_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "inbound_forwarding_requests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "inbound_forwarding_requests_organisation_id_idx"
  ON "inbound_forwarding_requests"("organisation_id");

-- What the guided screen reads: this organisation's requests, newest first.
CREATE INDEX "inbound_forwarding_requests_organisation_id_status_idx"
  ON "inbound_forwarding_requests"("organisation_id", "status", "created_at" DESC);

-- One request per confirmation email. See the column comment: this is what
-- makes a webhook replay a no-op instead of a second question.
CREATE UNIQUE INDEX "inbound_forwarding_requests_inbound_message_id_key"
  ON "inbound_forwarding_requests"("inbound_message_id");

ALTER TABLE "inbound_forwarding_requests"
  ADD CONSTRAINT "inbound_forwarding_requests_organisation_id_fkey"
    FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "inbound_forwarding_requests_inbound_address_id_fkey"
    FOREIGN KEY ("inbound_address_id") REFERENCES "inbound_addresses"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  -- RESTRICT for the same reason the message keeps its address: this row is the
  -- explanation of why a stranger's mail is arriving in somebody's book, and an
  -- explanation whose evidence has been deleted is not one.
  ADD CONSTRAINT "inbound_forwarding_requests_inbound_message_id_fkey"
    FOREIGN KEY ("inbound_message_id") REFERENCES "inbound_messages"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "inbound_forwarding_requests_status_check"
    CHECK ("status" IN ('pending', 'confirmed', 'declined')),
  -- Settled exactly when it is not pending. Without this the screen has two
  -- sources of truth for "is this finished" and they drift.
  ADD CONSTRAINT "inbound_forwarding_requests_settled_check"
    CHECK (("status" = 'pending') = ("settled_at" IS NULL)),
  -- ⚠️ THE SAME CASE-FOLDING RULE AS THE DOOR ITSELF (0029). This address is
  -- compared against what a customer reads off the guided screen and against
  -- the sender of mail that arrives later; two spellings of one mailbox would
  -- show as two separate requests and one of them would look unexplained.
  ADD CONSTRAINT "inbound_forwarding_requests_source_lowercase_check"
    CHECK ("source_address" = lower("source_address")),
  -- An address, not a display name and not an empty string. Google names the
  -- requesting mailbox; a row that cannot say which mailbox is a row the
  -- customer cannot answer.
  ADD CONSTRAINT "inbound_forwarding_requests_source_address_check"
    CHECK ("source_address" LIKE '%_@_%' AND length("source_address") BETWEEN 3 AND 320);

-- ---------------------------------------------------------------------------
-- Tenant isolation (migration 0008's shape, unchanged)
-- ---------------------------------------------------------------------------

ALTER TABLE inbound_forwarding_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbound_forwarding_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON inbound_forwarding_requests
  USING (organisation_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (organisation_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

-- ---------------------------------------------------------------------------
-- Runtime grants
-- ---------------------------------------------------------------------------
--
-- Migrations 0014–0016 removed every default privilege, so a new table starts
-- with no grants at all. UPDATE is how a request gets settled.
GRANT SELECT, INSERT, UPDATE ON inbound_forwarding_requests TO eva_app;

-- ⚠️ THE REVOKE IS THE RULE; THE GRANT ABOVE DOES NOTHING ON ITS OWN.
-- `ALTER DEFAULT PRIVILEGES FOR ROLE eva` hands `eva_app` all four privileges
-- on every table `eva` creates, and a GRANT only ever ADDS (0026, 0028 and 0029
-- each learned this the same way).
--
-- A declined request is the record of somebody trying to read a customer's
-- enquiries. Deleting it deletes the only evidence that it ever happened.
REVOKE DELETE ON inbound_forwarding_requests FROM eva_app;
