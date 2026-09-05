import type { TenantTx } from "../permissions/permissions.js";
import { writeAuditLog } from "../audit/audit-log.js";
import {
  normaliseSuppressionValue,
  personSuppressed,
  type SuppressionChannel,
} from "../suppression/suppression.js";

/**
 * Put an enquiry back to `new` when the do-not-contact behind it was corrected.
 *
 * ⚠️ THIS EXISTS BECAUSE THE FIRST CORRECTION EVER MADE ON PRODUCTION LEFT A
 * LIE ON THE SCREEN (2026-08-21). The founder pressed do-not-contact on their
 * own enquiry, both channels went on the list, both were corrected — and the
 * enquiry book still showed a red "Do not contact" pill on somebody Eva was by
 * then perfectly willing to write to. The suppression list said contactable and
 * the lead said otherwise, which is the money-bug family: a screen promising an
 * outcome that does not happen.
 *
 * The root cause is two records of one fact. `consent_events` is the gate
 * Eva actually obeys; `leads.status` is a label. When the gate opens, the label
 * has to follow, or one of them is wrong from that moment on.
 *
 * ⚠️ AND IT MUST NOT FOLLOW TOO EAGERLY — THIS IS THE PART A TEST PINS.
 * `doNotContact` suppresses EVERY channel it holds for somebody: an enquiry
 * with an address and a number puts two entries on the list. Correcting one of
 * them leaves the person still unreachable on the other, so an enquiry flipped
 * back to `new` after the first correction would say "Eva will contact them"
 * while she still refuses to. A lead only comes back when NOTHING about that
 * person is suppressed any more.
 */
export async function revertLeadsAfterCorrection(
  tx: TenantTx,
  input: {
    organisationId: string;
    channel: SuppressionChannel;
    value: string;
    actorUserId: string;
  },
): Promise<string[]> {
  const value = normaliseSuppressionValue(input.channel, input.value);

  /**
   * ⚠️ MATCHED THE SAME WAY `doNotContact` SUPPRESSED, INCLUDING THE BLIND
   * SPOT. Emails are case-folded and numbers are compared as typed, because
   * that is exactly what went onto the list. A cleverer match here would revert
   * enquiries whose suppression was never actually lifted.
   */
  const candidates = await tx.lead.findMany({
    where: {
      deletedAt: null,
      status: "do_not_contact",
      ...(input.channel === "email"
        ? { contactEmail: { equals: value, mode: "insensitive" as const } }
        : { contactPhone: value }),
    },
    select: { id: true, contactEmail: true, contactPhone: true },
  });

  const reverted: string[] = [];
  for (const lead of candidates) {
    // Every channel we hold for them has to be clear, not just the one that
    // was corrected.
    const stillSuppressed = await personSuppressed(tx, input.organisationId, {
      email: lead.contactEmail,
      phone: lead.contactPhone,
    });
    if (stillSuppressed) continue;

    await tx.lead.update({ where: { id: lead.id }, data: { status: "new" } });
    /**
     * ⚠️ ITS OWN AUDIT LINE, NOT A FOOTNOTE ON THE CORRECTION'S. Somebody
     * reading this enquiry's history needs to see that its state changed and
     * why, without knowing to go and look at a suppression entry that is keyed
     * by an address rather than by this lead.
     */
    await writeAuditLog(tx, {
      organisationId: input.organisationId,
      actorUserId: input.actorUserId,
      action: "lead.do_not_contact_reverted",
      entityType: "lead",
      entityId: lead.id,
      metadata: { channel: input.channel },
    });
    reverted.push(lead.id);
  }

  return reverted;
}
