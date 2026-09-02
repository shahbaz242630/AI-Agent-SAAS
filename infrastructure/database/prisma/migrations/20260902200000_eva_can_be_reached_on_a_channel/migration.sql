-- Slice 3.2c — migration 0040: Eva can be reached on a channel.
--
-- Two tables: which channel accounts belong to which organisation, and what
-- arrived on them. This is the receiving half of founder ruling 62; the reply
-- is 3.2d.
--
-- ⚠️ NAMED FOR CHANNELS, NOT FOR WHATSAPP, AND THAT IS A DEPARTURE WORTH
-- DEFENDING. This project's stated rule is to generalise when there is a second
-- implementation to generalise FROM (`reply-decision.ts` says so in as many
-- words), and there is only one today.
--
-- The exception is earned here because the second and third are not
-- speculative: `devtools_webhook_list` on our own Meta app returns
-- `whatsapp_business_account`, `page` and `instagram` topics, each with a
-- `messages` field, on the SAME app with the SAME signature scheme and the same
-- webhook shape. The generalisation is a fact about Meta's platform that has
-- been read back from it, not a guess about our roadmap.
--
-- ⚠️ THE CHECK STILL PERMITS ONLY `whatsapp`. Same position as migration 0039:
-- adding a channel is a migration. A generic SHAPE with a narrow VALUE SET is
-- the honest combination — the table will not need rebuilding, and a row no
-- code path handles still cannot be stored.

-- ---------------------------------------------------------------------------
-- channel_connections — whose account is this?
-- ---------------------------------------------------------------------------
--
-- 🚨 THIS TABLE IS HOW AN INBOUND MESSAGE FINDS ITS ORGANISATION, AND IT IS THE
-- ONLY WAY. Meta's webhook carries no tenant of ours — it names its own asset
-- ids and nothing else. Everything downstream (a lead in a named organisation,
-- and in 3.2d a reply sent as that customer) rests on this lookup, so the
-- uniqueness below is a security boundary and not bookkeeping.
CREATE TABLE "channel_connections" (
  "id"                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "organisation_id"     UUID NOT NULL REFERENCES "organisations"("id") ON DELETE CASCADE,
  -- Which product this connection serves. A mailbox belongs to ONE product
  -- (ruling 36/49) and a channel is the same kind of thing.
  "module_key"          TEXT NOT NULL,
  "channel"             TEXT NOT NULL,
  -- The account the asset hangs off: a WhatsApp Business Account id today, a
  -- Page id for Messenger, an Instagram account id later.
  "external_account_id" TEXT NOT NULL,
  -- The thing messages actually arrive at: WhatsApp's phone number id. Null for
  -- channels where the account IS the endpoint (Messenger's page).
  "external_asset_id"   TEXT,
  -- What a human would recognise it by — the display phone number. Never used
  -- for routing; `external_asset_id` is.
  "display_name"        TEXT,
  "status"              TEXT NOT NULL DEFAULT 'connected',
  "connected_by"        UUID REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at"          TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"          TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "deleted_at"          TIMESTAMPTZ(6),

  CONSTRAINT "channel_connections_channel_check"
    CHECK ("channel" IN ('whatsapp')),
  CONSTRAINT "channel_connections_module_key_check"
    CHECK ("module_key" IN (
      'email_credit_controller',
      'voice_credit_controller',
      'lead_follow_up',
      'lead_follow_up_voice',
      'ai_receptionist'
    )),
  CONSTRAINT "channel_connections_status_check"
    CHECK ("status" IN ('connected', 'needs_reconnect', 'disconnected'))
);

CREATE INDEX "channel_connections_organisation_id_idx"
  ON "channel_connections"("organisation_id");

-- 🚨 ONE ORGANISATION PER ASSET, ACROSS THE WHOLE TABLE — NOT PER TENANT.
--
-- This is the one unique index in the schema that is deliberately NOT scoped to
-- an organisation, and inverting it would be a tenancy breach rather than a
-- duplicate row. Routing runs the other way to every other query here: a
-- webhook arrives naming an asset, and we ask who owns it. If two organisations
-- could claim the same phone number id, that lookup returns two answers and the
-- code picks one — filing a stranger's enquiry in somebody else's book, and in
-- 3.2d replying to them as the wrong business.
--
-- COALESCE because `external_asset_id` is null for channels where the account
-- is the endpoint, and NULLs do not collide in a unique index — so without it
-- two organisations could both connect the same Page.
CREATE UNIQUE INDEX "channel_connections_asset_key"
  ON "channel_connections"("channel", "external_account_id", COALESCE("external_asset_id", ''))
  WHERE "deleted_at" IS NULL;

-- ---------------------------------------------------------------------------
-- inbound_channel_messages — what arrived.
-- ---------------------------------------------------------------------------
--
-- ⚠️ A SEPARATE TABLE FROM `inbound_messages`, ON PURPOSE. That one is email to
-- its bones: it has a NOT NULL `inbound_address_id` pointing at an address we
-- own, a `delivered_to`, a `subject`, and an `html_body`. A WhatsApp delivery
-- has none of those — it has a phone number, a message type, and text. Widening
-- the email table would mean four more nullable columns and a FK that stops
-- meaning anything, which is how a clean table becomes a junk drawer.
--
-- ⚠️ AND META KEEPS NO HISTORY. Their documentation states there is no API for
-- fetching past webhooks — *"capture and store webhook payloads accordingly"*.
-- Not stored is gone, permanently. That turns ruling 38's evidence rule from a
-- preference into a platform constraint.
CREATE TABLE "inbound_channel_messages" (
  "id"                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "organisation_id"      UUID NOT NULL REFERENCES "organisations"("id") ON DELETE CASCADE,
  "connection_id"        UUID NOT NULL REFERENCES "channel_connections"("id") ON DELETE RESTRICT,
  "channel"              TEXT NOT NULL,
  -- ⚠️ THE IDEMPOTENCY KEY. Meta retries a webhook that does not answer 200 —
  -- immediately, then with decreasing frequency for at least 36 hours — and
  -- batches up to 1000 updates per POST with no guarantee of batching at all.
  -- Without this, one retry is a second enquiry in somebody's book, and in
  -- 3.2d a second automatic reply to the same stranger.
  "provider_message_id"  TEXT NOT NULL,
  -- Who sent it, in WhatsApp's own form (E.164 without the +).
  "from_identifier"      TEXT NOT NULL,
  -- What they are called, if WhatsApp told us. Their profile name, not ours.
  "from_display_name"    TEXT,
  -- text | image | audio | video | document | sticker | location | contacts …
  -- Stored rather than filtered: a photo of the leaking roof may BE the enquiry.
  "message_type"         TEXT NOT NULL,
  -- Null for a message with no text at all (a bare image, a sticker).
  "text_body"            TEXT,
  -- ⚠️ THE WHOLE PAYLOAD, VERBATIM. The fields above are what we understand
  -- today; this is what actually arrived. Meta adds fields without notice and
  -- keeps no history, so anything not kept here cannot be recovered.
  "payload"              JSONB NOT NULL,
  -- received | converted | ignored | failed. Only states that can occur.
  "status"               TEXT NOT NULL DEFAULT 'received',
  "failure_reason"       TEXT,
  -- Set in 3.2d, when a message becomes a lead. Null here always.
  "lead_id"              UUID REFERENCES "leads"("id") ON DELETE SET NULL,
  -- ⚠️ THEIR CLOCK, NOT OURS — the same rule as `leads.received_at`. WhatsApp
  -- sends a unix timestamp with the message; speed-to-lead is measured from
  -- when the person sent it, not when we happened to process it.
  "received_at"          TIMESTAMPTZ(6) NOT NULL,
  "created_at"           TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"           TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

  CONSTRAINT "inbound_channel_messages_channel_check"
    CHECK ("channel" IN ('whatsapp')),
  CONSTRAINT "inbound_channel_messages_status_check"
    CHECK ("status" IN ('received', 'converted', 'ignored', 'failed'))
);

-- Unique per channel, not globally: two channels could in principle mint the
-- same id, and a collision across them would silently drop a real message.
CREATE UNIQUE INDEX "inbound_channel_messages_provider_message_key"
  ON "inbound_channel_messages"("channel", "provider_message_id");

CREATE INDEX "inbound_channel_messages_organisation_id_idx"
  ON "inbound_channel_messages"("organisation_id");

CREATE INDEX "inbound_channel_messages_waiting_idx"
  ON "inbound_channel_messages"("organisation_id", "received_at" DESC)
  WHERE "status" = 'received';

-- ---------------------------------------------------------------------------
-- Row-level security — the same tenant boundary as every other table.
-- ---------------------------------------------------------------------------
--
-- ⚠️ FORCED, NOT MERELY ENABLED. `ENABLE` exempts the table owner, and the
-- owner is who migrations run as; `FORCE` is what makes the policy apply to
-- everyone. Verified on production rather than assumed for 0035 and 0036, and
-- the same check applies here.
ALTER TABLE "channel_connections" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "channel_connections" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "channel_connections"
  USING ("organisation_id" = NULLIF(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK ("organisation_id" = NULLIF(current_setting('app.current_org', true), '')::uuid);

ALTER TABLE "inbound_channel_messages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inbound_channel_messages" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "inbound_channel_messages"
  USING ("organisation_id" = NULLIF(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK ("organisation_id" = NULLIF(current_setting('app.current_org', true), '')::uuid);

-- ---------------------------------------------------------------------------
-- Grants — and the REVOKE is the rule, not the GRANT.
-- ---------------------------------------------------------------------------
--
-- ⚠️ DEFAULT PRIVILEGES ALREADY GAVE `eva_app` EVERYTHING ON A TABLE THE OWNER
-- CREATES. Listing three verbs below removes nothing; only an explicit REVOKE
-- narrows it. That is migration 0035's lesson and 0037's, and it is why the
-- audit trail spent eleven sessions rewritable.
GRANT SELECT, INSERT, UPDATE ON "channel_connections" TO eva_app;
REVOKE DELETE ON "channel_connections" FROM eva_app;

GRANT SELECT, INSERT, UPDATE ON "inbound_channel_messages" TO eva_app;
-- A delivery is evidence of what a stranger sent (ruling 38). Nothing in the
-- application hard-deletes one, and now nothing can.
REVOKE DELETE ON "inbound_channel_messages" FROM eva_app;
