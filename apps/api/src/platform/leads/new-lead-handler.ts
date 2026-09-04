/**
 * How a capability hands a new lead to whoever cares (slice 3.1c-3; moved to
 * the platform in 3.3b).
 *
 * 🚨 THIS EXISTS BECAUSE A CAPABILITY MUST NEVER IMPORT A PRODUCT, AND
 * BECAUSE THERE IS NO EVENT BUS.
 *
 * Intake converts a delivery into a lead. Something then has to answer it — and
 * answering is the lead PRODUCT'S job (ruling 56: leads stay in `platform/`,
 * the product owns the reply). A direct call from an intake service to
 * `LeadReplyService` would be `capabilities/ → products/`, which
 * `pnpm boundaries` fails on, and rightly: it would make shared machinery
 * depend on one of the products it serves.
 *
 * ⚠️ AND AN EVENT BUS IS NOT THE ANSWER HERE. The architecture notes suggest
 * publishing a domain event and nothing implements one; the handoff says in
 * as many words: *"Do not build one for this."* The established shape is a PORT
 * with the implementation in the product, wired at the composition root — the
 * `MAIL_PROVIDERS` pattern. This is that, for a handoff rather than a provider.
 * Blueprint §3.4 says when the bus is earned: three subscribers, not one.
 *
 * ⚠️ IT LIVES IN `platform/leads/`, NOT IN A CAPABILITY, SINCE 3.3b. It began
 * life beside the mail door, which was its only caller. The WhatsApp door
 * (`capabilities/messaging`) now announces through it too, and one capability
 * may not import another — `cross-capability-import` in the wall — so the
 * port sits with the record it announces. Both doors import inward; the
 * products' composition root imports inward; nothing changed direction.
 *
 * ⚠️ A LIST, NOT ONE HANDLER. Lead Follow-up by Call and the CRM (rulings 14
 * and 16) will both want to know a lead arrived, and neither may reach into the
 * other. A single slot would make the second one a rewrite of the first.
 */

/** DI token for the handlers registered at the composition root. */
export const NEW_LEAD_HANDLERS = Symbol("NEW_LEAD_HANDLERS");

export interface NewLead {
  organisationId: string;
  leadId: string;
}

export interface NewLeadHandler {
  /**
   * ⚠️ MUST NOT THROW, AND MUST NOT BE SLOW ENOUGH TO MATTER.
   *
   * The caller is a webhook that has ALREADY stored the enquiry and is about to
   * answer 200. An exception escaping here would fail the webhook, the provider
   * would retry it, and intake's idempotency would correctly refuse to make a
   * second lead — so the enquiry would be safe but the retry storm would be
   * pointless. Worse, a handler that throws on every delivery would keep the
   * whole pipeline red for a fault in one product.
   *
   * The dispatchers enforce this by catching, but a handler that relies on
   * being caught is a handler nobody can reason about. Own your failures and
   * record them.
   */
  onNewLead(lead: NewLead): Promise<void>;
}

export type NewLeadHandlers = readonly NewLeadHandler[];
