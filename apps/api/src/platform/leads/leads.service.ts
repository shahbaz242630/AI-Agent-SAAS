import { Injectable, NotFoundException } from "@nestjs/common";
import { withTenant } from "@eva/database";
import type { CreateLeadRequest } from "@eva/validation";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PrismaService } from "../../common/database/prisma.service.js";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { UsersService } from "../users/users.service.js";
import { requirePermission, type TenantTx } from "../permissions/permissions.js";
import { writeAuditLog } from "../audit/audit-log.js";
import { addSuppression, type SuppressionChannel } from "../suppression/suppression.js";
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

/** A lead with the proof behind it — the detail screen's shape. */
export interface LeadDetail extends LeadSummary {
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
   * Logs an enquiry that arrived some other way — leads:write.
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
   * existing entry is a no-op by design (`SuppressionEntry` is unique on
   * channel+value), so this is safe to repeat and safe to race.
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
