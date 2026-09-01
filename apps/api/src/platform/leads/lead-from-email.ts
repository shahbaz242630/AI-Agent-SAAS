import type { TenantTx } from "../permissions/permissions.js";
import { writeAuditLog } from "../audit/audit-log.js";
import { unwrapForwardedEmail } from "./forwarded-email.js";

/**
 * Turning a delivered email into a lead and its evidence (Slice 3.1b).
 *
 * ⚠️ THIS IS THE PLATFORM'S JOB, NOT THE LEAD PRODUCT'S, AND `table-ownership.ts`
 * SAYS WHY: the lead RECORD is platform because three products will want the
 * same one — follow-up by email, follow-up by call, and the CRM. What the
 * PRODUCT will own is the machinery of ANSWERING: deciding an enquiry deserves
 * a reply (ruling 32) and sending it. Neither exists yet, which is why there is
 * no `products/lead-follow-up-email/` folder in this slice — a product folder
 * whose only content is a call into the platform is a folder pretending to be
 * a boundary.
 *
 * ⚠️ NO ACTING USER, ON PURPOSE. Mail arrives from a stranger, at a machine, at
 * four in the morning. `createdBy` and `actorUserId` are null — the same shape
 * the reconcile sweep uses — because inventing an actor for something no person
 * did would put a name against a record that person never touched.
 */

/** What the intake path knows by the time it has fetched the message. */
export interface EmailEnquiry {
  /** The `From` header, verbatim: `Jane Smith <jane@example.com>` or bare. */
  from: string;
  /** Which of our addresses it was delivered to. */
  deliveredTo: string;
  subject: string | null;
  /** The plain-text body, already fetched. */
  text: string | null;
  /** The provider's id for this message — the evidence's `external_id`. */
  providerMessageId: string;
  /** When it arrived at our door. Their clock, not ours. */
  receivedAt: Date;
}

/**
 * How much of the message is quoted onto the lead.
 *
 * ⚠️ THE WHOLE MESSAGE IS NOT LOST BY THIS — it is in
 * `inbound_messages.text_body`, complete. `lead_evidence.raw_excerpt` is named
 * an excerpt and is one; the lead's `enquiry` matches the 4,000 the API
 * contract has always accepted, so a lead made by email and a lead made any
 * other way hold the same shape of thing.
 */
const EXCERPT_LIMIT = 4000;

/** `Display Name <a@b.com>` — the name half is anything before the brackets. */
const ANGLE_ADDRESSED = /^(.*)<([^<>]+)>\s*$/;

/**
 * `Jane Smith <jane@example.com>` → name and address.
 *
 * ⚠️ DELIBERATELY NOT A FULL RFC 5322 PARSER. A real one handles comments,
 * folded whitespace, group syntax and quoted-pair escapes, and building one
 * here would be a large amount of code guarding a case that does not arrive
 * from a human writing an enquiry. What it MUST do is never mistake a display
 * name for an address: `contact_email` is what Eva will reply to, and replying
 * to the wrong string is worse than failing to parse.
 */
export function parseFromHeader(from: string): { name: string | null; email: string | null } {
  const trimmed = from.trim();
  if (!trimmed) return { name: null, email: null };

  const angled = trimmed.match(ANGLE_ADDRESSED);
  if (angled) {
    const rawName = angled[1]!
      .trim()
      .replace(/^"(.*)"$/, "$1")
      .trim();
    const email = angled[2]!.trim().toLowerCase();
    return {
      name: rawName.length > 0 ? rawName : null,
      email: looksLikeAddress(email) ? email : null,
    };
  }

  const bare = trimmed.toLowerCase();
  return { name: null, email: looksLikeAddress(bare) ? bare : null };
}

/**
 * The loosest check that is still worth making: exactly one `@`, something on
 * each side, and no whitespace.
 *
 * Deliberately not a validation regex. The address came from a message a mail
 * server already accepted and delivered; our opinion of its syntax is not the
 * authority, and rejecting a deliverable address would lose a real enquiry.
 * This only catches the case that matters — a `From` that is not an address at
 * all, which would otherwise be written into `contact_email` and replied to.
 */
function looksLikeAddress(value: string): boolean {
  if (/\s/.test(value)) return false;
  const parts = value.split("@");
  return parts.length === 2 && parts[0]!.length > 0 && parts[1]!.includes(".");
}

/** Trimmed and capped, or null when there is nothing to quote. */
function excerpt(text: string | null): string | null {
  const trimmed = text?.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, EXCERPT_LIMIT);
}

export interface CreatedLead {
  id: string;
}

/**
 * Writes the lead, its evidence and the audit line in ONE transaction — the
 * same transaction the caller uses to mark the delivery converted.
 *
 * ⚠️ EVIDENCE IN THE SAME TRANSACTION AS THE LEAD, ALWAYS. BRD 4.3: "A lead
 * without complete channel-appropriate evidence must never enter the call
 * queue." A lead that committed without its proof would be a record nobody is
 * allowed to act on, sitting in the book looking exactly like one they are.
 *
 * Throws when the message carries no usable sender address: a lead with no way
 * to answer it cannot be followed up, and `leads_contact_check` refuses it in
 * the database anyway. The caller records the failure against the delivery, so
 * the message is still kept and still visible.
 */
export async function createLeadFromEmail(
  tx: TenantTx,
  organisationId: string,
  enquiry: EmailEnquiry,
): Promise<CreatedLead> {
  /**
   * ⚠️ A MANUALLY FORWARDED ENQUIRY IS ABOUT SOMEBODY ELSE, AND BOTH HALVES OF
   * IT MOVE (slice 3.1c-0b). When a customer presses Forward, the `From` header
   * becomes THEM and their covering note sits above the real message — so
   * without this the lead is filed against the customer, quotes their note as
   * the enquiry, and 3.1c would answer them instead of the person who asked.
   * Seen on a real production lead.
   *
   * `unwrapForwardedEmail` returns null for anything it cannot read with
   * confidence, and null means "use the message exactly as it arrived" — the
   * behaviour that has always been here.
   */
  const forwarded = unwrapForwardedEmail(enquiry.text);
  const fromHeader = forwarded?.from ?? enquiry.from;
  const { name, email } = parseFromHeader(fromHeader);
  if (!email) {
    throw new Error(`Could not read a sender address from '${fromHeader}'`);
  }

  const body = excerpt(forwarded?.body ?? enquiry.text);
  const lead = await tx.lead.create({
    data: {
      organisationId,
      source: "email_enquiry",
      contactName: name,
      contactEmail: email,
      contactPhone: null,
      enquiry: body,
      receivedAt: enquiry.receivedAt,
      createdBy: null,
      evidence: {
        create: {
          organisationId,
          // The channel and the source are the same fact from two sides.
          channel: "email_enquiry",
          externalId: enquiry.providerMessageId,
          /**
           * ⚠️ FILLED FROM THIS SLICE ONWARD. These three columns shipped with
           * migration 0026 and stood empty through 3.1a because nothing could
           * write them — the only way to make a lead was by hand. They are the
           * difference between "somebody enquired" and "this address wrote to
           * that address about this, and here is the message id": the part of
           * the evidence that can actually be checked against a mail server.
           */
          senderAddress: email,
          recipientAddress: enquiry.deliveredTo,
          // The forwarded block's own subject when there is one: the outer
          // subject is whatever the forwarder's client prefixed with "Fwd:".
          subject: forwarded?.subject ?? enquiry.subject,
          occurredAt: enquiry.receivedAt,
          rawExcerpt: body,
          createdBy: null,
        },
      },
    },
    select: { id: true },
  });

  await writeAuditLog(tx, {
    organisationId,
    actorUserId: null,
    action: "lead.received",
    entityType: "lead",
    entityId: lead.id,
    /**
     * The source and the moment, never the enquiry text and never the sender —
     * the same restraint `lead.logged` shows. An audit log is read far more
     * widely than the record it describes, and this one describes a stranger.
     */
    metadata: { source: "email_enquiry", receivedAt: enquiry.receivedAt.toISOString() },
  });

  return lead;
}
