import type { TenantTx } from "../permissions/permissions.js";
import { writeAuditLog } from "../audit/audit-log.js";
import { excerpt, type CreatedLead, type LeadSpine } from "./lead-writer.js";

/**
 * Turning a WhatsApp message into a lead and its evidence (slice 3.3b, ruling
 * 62: Lead Follow-up is one multi-channel feature).
 *
 * The sibling of `createLeadFromEmail`, and deliberately not a generalisation
 * of it. An email has a `From` header to parse and a forwarding wrapper to
 * unwrap; a channel message arrives with the sender's id already separated
 * from their name by the channel itself. Two small writers that each say
 * exactly what they store beat one that takes a union and a switch.
 *
 * ⚠️ NO ACTING USER, ON PURPOSE — the same rule as the email writer. Nobody
 * at the business did this.
 */

/** What the channel intake knows by the time it has stored the delivery. */
export interface ChannelEnquiry {
  /** Their profile name as the channel reported it. Theirs, not ours. */
  displayName: string | null;
  /** E.164 with the plus — what the lead can be answered on. */
  phone: string;
  /** The words, if any. Null for a bare photo or sticker, which may BE the enquiry. */
  text: string | null;
  /** Meta's `wamid` — the evidence's `external_id`. */
  providerMessageId: string;
  /** The number of OURS it arrived at, as a human would recognise it. */
  deliveredTo: string;
  /** When it arrived. Their clock, not ours. */
  receivedAt: Date;
}

/**
 * Writes the lead, its evidence and the audit line in the caller's
 * transaction — the one that stored the delivery and wrote the spine.
 *
 * ⚠️ EVIDENCE IN THE SAME TRANSACTION AS THE LEAD, ALWAYS (BRD 4.3). And the
 * evidence's `sender_address` / `recipient_address` are the two numbers: the
 * columns were named for mail, but what they record is "this handle wrote to
 * that handle of ours", which is the same claim on every channel and the one
 * that can be checked against the provider.
 */
export async function createLeadFromChannelMessage(
  tx: TenantTx,
  organisationId: string,
  enquiry: ChannelEnquiry,
  spine: LeadSpine,
): Promise<CreatedLead> {
  const body = excerpt(enquiry.text);

  const lead = await tx.lead.create({
    data: {
      organisationId,
      source: "whatsapp_enquiry",
      contactName: enquiry.displayName,
      contactEmail: null,
      contactPhone: enquiry.phone,
      // Null when they sent a photo and no words: inventing a summary would
      // put words in a stranger's mouth on a compliance record.
      enquiry: body,
      receivedAt: enquiry.receivedAt,
      createdBy: null,
      personId: spine.personId,
      pipelineStageId: spine.pipelineStageId,
      originConversationId: spine.originConversationId,
      evidence: {
        create: {
          organisationId,
          // The channel and the source are the same fact from two sides.
          channel: "whatsapp_enquiry",
          externalId: enquiry.providerMessageId,
          senderAddress: enquiry.phone,
          recipientAddress: enquiry.deliveredTo,
          // WhatsApp has no subject line, and 0039's rule holds all the way
          // down: nothing invents one.
          subject: null,
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
    // The source and the moment, never the message and never the number.
    metadata: { source: "whatsapp_enquiry", receivedAt: enquiry.receivedAt.toISOString() },
  });

  return lead;
}
