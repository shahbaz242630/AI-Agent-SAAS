import { Injectable, NotFoundException } from "@nestjs/common";
import { withTenant } from "@eva/database";
import type { CreateLeadRequest } from "@eva/validation";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PrismaService } from "../../common/database/prisma.service.js";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { UsersService } from "../users/users.service.js";
import { requirePermission, type TenantTx } from "../permissions/permissions.js";
import { writeAuditLog } from "../audit/audit-log.js";
import {
  addSuppression,
  normaliseSuppressionValue,
  type SuppressionChannel,
} from "../suppression/suppression.js";
import type { AuthUser } from "../authentication/current-auth-user.decorator.js";

/**
 * A lead as a screen reads it.
 *
 * `hasEvidence` is on the summary rather than left to be inferred: BRD 4.3 says
 * a lead without channel-appropriate evidence must never be contacted, so
 * whether we can prove the enquiry is a fact about the lead, not a detail of
 * how it was stored.
 */
export interface LeadSummary {
  id: string;
  source: string;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  enquiry: string | null;
  status: string;
  receivedAt: Date;
  firstRespondedAt: Date | null;
  customerId: string | null;
  hasEvidence: boolean;
  createdAt: Date;
}

/**
 * Who ELSE stops being contactable if this lead is marked do-not-contact.
 *
 * ⚠️ THIS EXISTS BECAUSE THE ACTION REACHES FURTHER THAN THE SCREEN IT SITS ON,
 * AND THE FOUNDER WALKED STRAIGHT INTO IT (2026-08-20). Suppression is by
 * VALUE, organisation-wide and cross-product by BRD design — so a
 * do-not-contact on an enquiry silently stops invoice chasers to the same
 * address. The first lead ever logged on production used an address that is
 * also a client's billing contact; nothing on the screen said so, and it was
 * only caught by reading the database by hand.
 *
 * Naming the blast radius before somebody commits to it is the fix. The
 * suppression itself stays permanent — that is the compliance guarantee, not
 * the bug.
 */
export interface LeadAlsoAffects {
  customerId: string;
  customerName: string;
  /** Which detail they share — the same channels the action will suppress. */
  matchedOn: ("email" | "phone")[];
}

/** A lead with the proof behind it — the detail screen's shape. */
export interface LeadDetail extends LeadSummary {
  /**
   * Clients who share this person's email address or phone number, and would
   * therefore be silenced too. Empty when nobody else is affected.
   */
  alsoAffects: LeadAlsoAffects[];
  evidence: {
    channel: string;
    externalId: string | null;
    senderAddress: string | null;
    recipientAddress: string | null;
    subject: string | null;
    occurredAt: Date;
    rawExcerpt: string | null;
    recordedAt: Date;
  } | null;
}

@Injectable()
export class LeadsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly usersService: UsersService,
  ) {}

  /** The lead book, newest enquiry first — leads:read. */
  async list(authUser: AuthUser, organisationId: string): Promise<LeadSummary[]> {
    const user = await this.usersService.resolveOrProvision(authUser);
    return withTenant(this.prisma.db, { organisationId, userId: user.id }, async (tx) => {
      await requirePermission(tx, organisationId, user.id, "leads:read");
      const leads = await tx.lead.findMany({
        where: { deletedAt: null },
        orderBy: { receivedAt: "desc" },
        include: { evidence: { select: { id: true } } },
      });
      return leads.map((lead) => toSummary(lead));
    });
  }

  /** One lead and the evidence behind it — leads:read. */
  async getById(authUser: AuthUser, organisationId: string, leadId: string): Promise<LeadDetail> {
    const user = await this.usersService.resolveOrProvision(authUser);
    return withTenant(this.prisma.db, { organisationId, userId: user.id }, async (tx) => {
      await requirePermission(tx, organisationId, user.id, "leads:read");
      const lead = await tx.lead.findFirst({
        where: { id: leadId, deletedAt: null },
        include: { evidence: true },
      });
      if (!lead) throw new NotFoundException("Lead not found");
      return {
        ...toSummary(lead),
        alsoAffects: await this.whoElseWouldBeSilenced(tx, lead),
        evidence: lead.evidence
          ? {
              channel: lead.evidence.channel,
              externalId: lead.evidence.externalId,
              senderAddress: lead.evidence.senderAddress,
              recipientAddress: lead.evidence.recipientAddress,
              subject: lead.evidence.subject,
              occurredAt: lead.evidence.occurredAt,
              rawExcerpt: lead.evidence.rawExcerpt,
              recordedAt: lead.evidence.createdAt,
            }
          : null,
      };
    });
  }

  /**
   * Records an enquiry that arrived in the customer's mailbox — leads:write.
   *
   * ⚠️ THE LEAD AND ITS EVIDENCE ARE WRITTEN IN ONE TRANSACTION, AND THAT IS
   * THE COMPLIANCE RULE, NOT TIDINESS. BRD 4.3: "A lead without complete
   * channel-appropriate evidence must never enter the call queue." A lead
   * created now and evidenced later is a lead that exists, for however long,
   * in exactly the state the rule forbids — and "we'll add the evidence in a
   * moment" is how that becomes permanent.
   *
   * The evidence row is written once and can never be changed afterwards: the
   * app role holds no UPDATE on that table (migration 0026).
   */
  async create(
    authUser: AuthUser,
    organisationId: string,
    input: CreateLeadRequest,
  ): Promise<LeadDetail> {
    const user = await this.usersService.resolveOrProvision(authUser);
    return withTenant(this.prisma.db, { organisationId, userId: user.id }, async (tx) => {
      await requirePermission(tx, organisationId, user.id, "leads:write");
      if (input.customerId) await this.requireCustomer(tx, input.customerId);

      const receivedAt = new Date(input.receivedAt);
      const lead = await tx.lead.create({
        data: {
          organisationId,
          source: input.source,
          contactName: input.contactName ?? null,
          contactEmail: input.contactEmail ?? null,
          contactPhone: input.contactPhone ?? null,
          enquiry: input.enquiry ?? null,
          receivedAt,
          customerId: input.customerId ?? null,
          createdBy: user.id,
          evidence: {
            create: {
              organisationId,
              // The channel and the source are the same fact seen from two
              // sides; letting them disagree would mean evidence that proves a
              // different enquiry from the one it is attached to.
              channel: input.source,
              externalId: input.evidenceExternalId ?? null,
              /**
               * ⚠️ THE ENQUIRY'S OWN MOMENT, NOT THE MOMENT SOMEBODY TYPED IT
               * IN. The whole point of storing evidence is to show when the
               * person contacted the business.
               */
              occurredAt: receivedAt,
              rawExcerpt: input.evidenceExcerpt ?? input.enquiry ?? null,
              createdBy: user.id,
            },
          },
        },
        include: { evidence: true },
      });

      await writeAuditLog(tx, {
        organisationId,
        actorUserId: user.id,
        action: "lead.logged",
        entityType: "lead",
        entityId: lead.id,
        // The source and when it happened, never the enquiry text: an audit log
        // is read far more widely than the record it describes.
        metadata: { source: lead.source, receivedAt: lead.receivedAt.toISOString() },
      });

      return {
        ...toSummary(lead),
        // Computed here too: an enquiry can arrive from somebody who is already
        // a client, and the screen that appears next carries the same button.
        alsoAffects: await this.whoElseWouldBeSilenced(tx, lead),
        evidence: {
          channel: lead.evidence!.channel,
          externalId: lead.evidence!.externalId,
          senderAddress: lead.evidence!.senderAddress,
          recipientAddress: lead.evidence!.recipientAddress,
          subject: lead.evidence!.subject,
          occurredAt: lead.evidence!.occurredAt,
          rawExcerpt: lead.evidence!.rawExcerpt,
          recordedAt: lead.evidence!.createdAt,
        },
      };
    });
  }

  /**
   * "Do not contact me again" — leads:write.
   *
   * ⚠️ IT WRITES THE SUPPRESSION LIST, NOT JUST THE LEAD. BRD 4.3: any such
   * request is "actioned immediately and permanently… and applies across all
   * channels". Marking only this lead would leave the same person contactable
   * the moment they enquire again, or through a different product — which is
   * exactly the complaint that makes a regulator interested.
   *
   * Every address and number we hold for them goes on the list. Re-adding an
   * already-suppressed value is a no-op by design, so this is safe to repeat.
   *
   * ⚠️ IT IS ALSO WHAT RE-ASSERTS A REQUEST AFTER A CORRECTION (0028). If this
   * address was suppressed by mistake and corrected, and the person then
   * genuinely asks, this writes a new `suppress` event that supersedes the
   * correction. Under the old unique-key upsert it would have done nothing at
   * all and left them contactable — a real request that silently failed.
   */
  async doNotContact(
    authUser: AuthUser,
    organisationId: string,
    leadId: string,
  ): Promise<LeadSummary> {
    const user = await this.usersService.resolveOrProvision(authUser);
    return withTenant(this.prisma.db, { organisationId, userId: user.id }, async (tx) => {
      await requirePermission(tx, organisationId, user.id, "leads:write");
      const lead = await tx.lead.findFirst({ where: { id: leadId, deletedAt: null } });
      if (!lead) throw new NotFoundException("Lead not found");

      /**
       * ⚠️ THE PHONE CHANNEL IS CALLED `call`, NOT `phone`. Slice 1.1 fixed the
       * vocabulary (`SUPPRESSION_CHANNELS`) and the database has a CHECK on it;
       * a hand-written `"phone"` here would have been refused at runtime by a
       * path nothing exercises until a real person asks not to be contacted.
       *
       * `addSuppression` also normalises the value — emails are case-folded, so
       * `Sam@Example.com` and `sam@example.com` cannot both slip through as two
       * different people. Hand-rolling the upsert would have skipped that.
       */
      const entries: { channel: SuppressionChannel; value: string }[] = [];
      if (lead.contactEmail) entries.push({ channel: "email", value: lead.contactEmail });
      if (lead.contactPhone) entries.push({ channel: "call", value: lead.contactPhone });

      for (const entry of entries) {
        await addSuppression(tx, {
          organisationId,
          channel: entry.channel,
          value: entry.value,
          reason: "lead_requested",
          createdBy: user.id,
        });
      }

      const updated = await tx.lead.update({
        where: { id: lead.id },
        data: { status: "do_not_contact" },
        include: { evidence: { select: { id: true } } },
      });

      await writeAuditLog(tx, {
        organisationId,
        actorUserId: user.id,
        action: "lead.do_not_contact",
        entityType: "lead",
        entityId: lead.id,
        metadata: { channelsSuppressed: entries.map((entry) => entry.channel) },
      });

      return toSummary(updated);
    });
  }

  /**
   * The clients a do-not-contact on this lead would silence as well.
   *
   * ⚠️ IT MIRRORS `doNotContact` EXACTLY, INCLUDING ITS BLIND SPOTS, AND THAT
   * IS THE POINT. The action suppresses the email case-folded and the phone
   * number as typed (`normaliseSuppressionValue`), so this matches the same way.
   * A cleverer match here — stripping spaces from numbers, comparing +44 to 0 —
   * would warn about clients the action would NOT actually silence, and a
   * warning that overstates gets ignored, which is worse than none.
   *
   * The reverse blind spot is real and deliberate: `07700 900123` and
   * `+447700900123` are the same person to a human and two different values to
   * the suppression list, so neither the action nor this warning connects them.
   * That is a limitation of suppression-by-value, not of this function, and it
   * is the same on both sides — which is what keeps the warning honest.
   *
   * ⚠️ CONTACTS AND CUSTOMERS ARE PLATFORM TABLES, so reading them here crosses
   * no wall — `table-ownership.ts` lists both alongside `lead`. This would be a
   * violation if it lived in the lead PRODUCT, which is one more reason the
   * lead record is platform.
   */
  private async whoElseWouldBeSilenced(
    tx: TenantTx,
    lead: { contactEmail: string | null; contactPhone: string | null },
  ): Promise<LeadAlsoAffects[]> {
    const email = lead.contactEmail ? normaliseSuppressionValue("email", lead.contactEmail) : null;
    const phone = lead.contactPhone ? normaliseSuppressionValue("call", lead.contactPhone) : null;
    if (!email && !phone) return [];

    const matches = await tx.contact.findMany({
      where: {
        deletedAt: null,
        OR: [...(email ? [{ email }] : []), ...(phone ? [{ phone }] : [])],
      },
      select: {
        email: true,
        phone: true,
        customer: { select: { id: true, name: true, deletedAt: true } },
      },
    });

    /**
     * ⚠️ ONE ENTRY PER CLIENT, NOT PER CONTACT. A client with two people on the
     * same shared inbox would otherwise be named twice in the same sentence.
     */
    const byCustomer = new Map<string, LeadAlsoAffects>();
    for (const match of matches) {
      // A deleted client cannot be chased, so naming it would be a warning
      // about something that cannot happen.
      if (!match.customer || match.customer.deletedAt !== null) continue;
      const existing = byCustomer.get(match.customer.id) ?? {
        customerId: match.customer.id,
        customerName: match.customer.name,
        matchedOn: [] as ("email" | "phone")[],
      };
      if (email && match.email === email && !existing.matchedOn.includes("email")) {
        existing.matchedOn.push("email");
      }
      if (phone && match.phone === phone && !existing.matchedOn.includes("phone")) {
        existing.matchedOn.push("phone");
      }
      byCustomer.set(match.customer.id, existing);
    }
    return [...byCustomer.values()].sort((a, b) => a.customerName.localeCompare(b.customerName));
  }

  private async requireCustomer(tx: TenantTx, customerId: string): Promise<void> {
    const customer = await tx.customer.findFirst({
      where: { id: customerId, deletedAt: null },
      select: { id: true },
    });
    if (!customer) throw new NotFoundException("Client not found");
  }
}

/** One shape for the book and the detail screen, so they cannot disagree. */
function toSummary(lead: {
  id: string;
  source: string;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  enquiry: string | null;
  status: string;
  receivedAt: Date;
  firstRespondedAt: Date | null;
  customerId: string | null;
  createdAt: Date;
  evidence: { id: string } | null;
}): LeadSummary {
  return {
    id: lead.id,
    source: lead.source,
    contactName: lead.contactName,
    contactEmail: lead.contactEmail,
    contactPhone: lead.contactPhone,
    enquiry: lead.enquiry,
    status: lead.status,
    receivedAt: lead.receivedAt,
    firstRespondedAt: lead.firstRespondedAt,
    customerId: lead.customerId,
    hasEvidence: lead.evidence !== null,
    createdAt: lead.createdAt,
  };
}
