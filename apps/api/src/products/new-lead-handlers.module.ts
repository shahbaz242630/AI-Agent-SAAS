import { Global, Module } from "@nestjs/common";
import { NEW_LEAD_HANDLERS } from "../capabilities/mailbox/inbound/new-lead-handler.js";
import type { NewLeadHandler } from "../capabilities/mailbox/inbound/new-lead-handler.js";
import { LeadReplyModule } from "./lead-follow-up/reply/lead-reply.module.js";
import { ReplyToNewLeadHandler } from "./lead-follow-up/reply/reply-to-new-lead.handler.js";

/**
 * Who wants to know when a lead arrives (slice 3.1c-3).
 *
 * ⚠️ THIS FILE SITS BESIDE `products/index.ts` FOR THE SAME REASON THAT ONE
 * DOES: it is a composition root, and a composition root is allowed to know
 * both sides. The mailbox capability announces a new lead through a port and
 * must never learn which products listen — `pnpm boundaries` forbids
 * `capabilities/ → products/`, and rightly, because shared machinery that
 * imports one of the products it serves is no longer shared.
 *
 * 🚨 IT IS `@Global()`, AND THE FIRST ATTEMPT WITHOUT THAT SILENTLY DID NOTHING.
 *
 * The obvious design was a dynamic module — `MailboxesModule.withNewLeadHandlers([...])`
 * called from `app.module.ts`, with an empty array as the static default. It
 * type-checked, both boundary walls passed, the whole app booted, every
 * existing test stayed green, **and no reply was ever sent.**
 *
 * Nest keys a dynamic module by its metadata, so
 * `MailboxesModule.withNewLeadHandlers(...)` is a DIFFERENT module instance
 * from the plain `MailboxesModule` that `RemindersModule` and `LeadReplyModule`
 * both import. `InboundIntakeService` resolved from the plain one and got the
 * empty default. Nothing failed anywhere — the loop simply had nothing to
 * iterate. It was found by an end-to-end test asserting a reply actually went
 * out, and by nothing else.
 *
 * A global provider has no such ambiguity: there is one token, registered once,
 * visible to whichever module instance asks. The injection site is `@Optional`
 * so a spec importing the capability alone still constructs.
 *
 * ⚠️ ADDING A LISTENER IS ONE ENTRY IN EACH ARRAY. Lead Follow-up by Call
 * (ruling 14) and the CRM (ruling 16) both want this, and neither may reach
 * into the other.
 */
@Global()
@Module({
  imports: [LeadReplyModule],
  providers: [
    {
      provide: NEW_LEAD_HANDLERS,
      /**
       * ⚠️ TOKENS INJECTED, NOT INSTANCES CONSTRUCTED HERE. Building a handler
       * with `new` would put it outside Nest's container: its own dependencies
       * would be unresolved, and a test's `overrideProvider` would point at
       * nothing while the real one ran underneath — the trap `MAIL_PROVIDERS`
       * records about registering a separately-constructed adapter.
       */
      inject: [ReplyToNewLeadHandler],
      useFactory: (...handlers: NewLeadHandler[]): readonly NewLeadHandler[] => handlers,
    },
  ],
  exports: [NEW_LEAD_HANDLERS],
})
export class NewLeadHandlersModule {}
