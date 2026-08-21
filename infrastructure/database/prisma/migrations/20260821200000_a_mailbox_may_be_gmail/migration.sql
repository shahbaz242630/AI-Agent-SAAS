-- Slice 3.1b — migration 0030: a mailbox may be Gmail.
--
-- One constraint, widened. It is small and it is the thing that has been
-- excluding most of our intended market from BOTH products.
--
-- ⚠️ THE PRODUCT WE ALREADY SELL WAS MICROSOFT-ONLY, AND NOBODY HAD SAID SO
-- OUT LOUD. Eva sends from the customer's own mailbox, and the only mailbox
-- that could be connected was Microsoft — so a sole trader on Gmail could not
-- use Invoice Chasing either. For a platform aimed at freelancers and small
-- businesses that is exactly the wrong way round: we supported the customers
-- with an IT department and excluded the ones without.
--
-- ⚠️ WHY `gmail.send` COSTS NOTHING AND READING WOULD COST AN AUDIT EVERY YEAR
-- (ruling 25). On Google's own classification, every way of READING a Gmail
-- inbox — including `gmail.metadata`, which sees only sender and subject — is
-- a RESTRICTED scope: a security assessment repeated within 12 months, 4-12
-- weeks to approval, and a 100-user cap until it clears. `gmail.send` is merely
-- SENSITIVE: one review, no audit, no fee. Sending is cheap and reading is
-- expensive, which is the opposite of the intuition, and it is why enquiries
-- arrive at an address we own (migration 0029) rather than out of the
-- customer's inbox.
--
-- ⚠️ THIS MIGRATION IS DELIBERATELY NOT SHIPPED ALONE. A CHECK that permits a
-- value nothing can produce is the `ends_at` trap from migration 0024: a column
-- whose only value is the one nobody sets. It lands with the Gmail adapter, the
-- OAuth route and the screen in the same change, and `mailbox-providers.spec.ts`
-- fails the build if this list and `MAIL_PROVIDER_KEYS` ever disagree.

ALTER TABLE "email_accounts" DROP CONSTRAINT "email_accounts_provider_check";

ALTER TABLE "email_accounts"
  ADD CONSTRAINT "email_accounts_provider_check"
    CHECK ("provider" IN ('microsoft', 'google'));

-- ---------------------------------------------------------------------------
-- Nothing else changes, and that is worth stating.
-- ---------------------------------------------------------------------------
--
-- No column is added. A Gmail mailbox is stored exactly as a Microsoft one:
-- same encrypted token pair, same expiry, same scopes array, same health
-- status, same seat accounting, same client allocation. The provider is one
-- string on the row, and everything reading that row already knew it was there
-- (`provider` has existed with a default since migration 0018).
--
-- ⚠️ EXISTING ROWS ARE UNTOUCHED AND STAY 'microsoft'. There is no back-fill to
-- get wrong: the column has never been null and the default has never changed.
