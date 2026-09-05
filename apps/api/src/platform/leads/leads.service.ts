import { Injectable, NotFoundException } from "@nestjs/common";
import { withTenant } from "@eva/database";
import { LEAD_SOURCES_BY_CHANNEL } from "@eva/types";
import type {
  CreateLeadRequest,
  LeadExportQuery,
  LeadListQuery,
  LeadTimelineQuery,
} from "@eva/validation";
import { leadBookCsv } from "./lead-book-csv.js";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PrismaService } from "../../common/database/prisma.service.js";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { UsersService } from "../users/users.service.js";
import { requirePermission, type TenantTx } from "../permissions/permissions.js";
import { writeAuditLog } from "../audit/audit-log.js";
import { ensureSystemStages } from "../people/spine.js";
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
  /** Where it sits in the pipeline: a system stage's key, or null for a custom one. */
  stage: { key: string | null; name: string };
}

/** One pipeline stage as the book's tabs show it, with how many match. */
export interface LeadBookStage {
  id: string;
  key: string | null;
  name: string;
  position: number;
  count: number;
}

/** A page of the book, and the counts its tabs need (ruling 81). */
export interface LeadBook {
  rows: LeadSummary[];
  totalCount: number;
  stages: LeadBookStage[];
}

/** A page of the conversation, newest first. */
export interface TimelinePage {
  items: TimelineItem[];
  /** True when older items exist before the last one here. */
  hasEarlier: boolean;
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

/**
 * One entry on a person's timeline (slice 3.3c) — a row of the
 * `person_timeline` view, which unions `messages` and `activities`.
 *
 * ⚠️ PER PERSON, NOT PER LEAD, AND THAT IS THE 360 (ruling 67). A repeat
 * customer's earlier enquiries and Eva's earlier replies belong on the same
 * screen as today's message; the enquiry is only the way in.
 */
export interface TimelineItem {
  id: string;
  type: "message" | "activity";
  /** `email` | `whatsapp` for a message; null for an activity. */
  channel: string | null;
  /** A message's direction (`inbound` | `outbound`); an activity's kind. */
  detail: string;
  /** `person` | `user` | `assistant` | `system`. */
  actorKind: string;
  /** Email messages only. */
  subject: string | null;
  /** A message's words, or an activity's one-line summary. */
  summary: string | null;
  conversationId: string | null;
  /** The enquiry an activity was posted on, when it names one. */
  leadId: string | null;
  happenedAt: Date;
}

/** The view's columns, as `$queryRaw` hands them back. */
interface TimelineRow {
  item_type: "message" | "activity";
  item_id: string;
  channel: string | null;
  detail: string;
  actor_kind: string;
  subject: string | null;
  summary: string | null;
  conversation_id: string | null;
  lead_id: string | null;
  happened_at: Date;
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

  /**
   * The lead book: a page of enquiries, newest first, with the filters the
   * screen offers and a count per stage for its tabs (ruling 81, 2026-09-05).
   *
   * ⚠️ ONE QUERY AT A TIME INSIDE THE TENANT TRANSACTION. Prisma's interactive
   * transaction runs on one connection, so the four reads go in sequence
   * rather than in a `Promise.all` that would interleave them on it.
   *
   * ⚠️ THE STAGE COUNTS IGNORE THE STAGE FILTER AND HONOUR THE OTHERS. A tab
   * says how many of "the WhatsApp ones you searched for" sit in each stage;
   * counting under the selected stage would zero every other tab the moment
   * one was chosen.
   */
  async list(authUser: AuthUser, organisationId: string, query: LeadListQuery): Promise<LeadBook> {
    const user = await this.usersService.resolveOrProvision(authUser);
    return withTenant(this.prisma.db, { organisationId, userId: user.id }, async (tx) => {
      await requirePermission(tx, organisationId, user.id, "leads:read");
      const where = leadBookWhere(query);
      const rows = await tx.lead.findMany({
        where,
        orderBy: [{ receivedAt: "desc" }, { id: "asc" }],
        take: query.limit,
        skip: query.offset,
        include: { evidence: { select: { id: true } }, pipelineStage: STAGE_SELECT },
      });
      const totalCount = await tx.lead.count({ where });
      const perStage = await tx.lead.groupBy({
        by: ["pipelineStageId"],
        where: leadBookWhere({ ...query, stage: undefined }),
        _count: { _all: true },
      });
      const stages = await tx.pipelineStage.findMany({
        where: { deletedAt: null },
        orderBy: { position: "asc" },
        select: { id: true, systemKey: true, name: true, position: true },
      });
      const countByStage = new Map(perStage.map((row) => [row.pipelineStageId, row._count._all]));
      return {
        rows: rows.map((lead) => toSummary(lead)),
        totalCount,
        stages: stages.map((stage) => ({
          id: stage.id,
          key: stage.systemKey,
          name: stage.name,
          position: stage.position,
          count: countByStage.get(stage.id) ?? 0,
        })),
      };
    });
  }

  /**
   * The book as a file, for the customer's own records (founder, 2026-09-05).
   * Every row the filter selects, never a page — the All tab is one click
   * away for somebody who wants the lot.
   */
  async exportCsv(
    authUser: AuthUser,
    organisationId: string,
    query: LeadExportQuery,
  ): Promise<{ csv: string; filename: string }> {
    const user = await this.usersService.resolveOrProvision(authUser);
    return withTenant(this.prisma.db, { organisationId, userId: user.id }, async (tx) => {
      await requirePermission(tx, organisationId, user.id, "leads:read");
      const settings = await tx.organisationSettings.findFirst({ select: { timezone: true } });
      const timezone = settings?.timezone ?? "Europe/London";
      const rows = await tx.lead.findMany({
        where: leadBookWhere(query),
        orderBy: [{ receivedAt: "desc" }, { id: "asc" }],
        include: { evidence: { select: { id: true } }, pipelineStage: STAGE_SELECT },
      });
      const day = new Date().toISOString().slice(0, 10);
      return {
        csv: leadBookCsv(
          rows.map((lead) => toSummary(lead)),
          timezone,
        ),
        filename: `enquiries-${day}.csv`,
      };
    });
  }

  /** One lead and the evidence behind it — leads:read. */
  async getById(authUser: AuthUser, organisationId: string, leadId: string): Promise<LeadDetail> {
    const user = await this.usersService.resolveOrProvision(authUser);
    return withTenant(this.prisma.db, { organisationId, userId: user.id }, async (tx) => {
      await requirePermission(tx, organisationId, user.id, "leads:read");
      const lead = await tx.lead.findFirst({
        where: { id: leadId, deletedAt: null },
        include: { evidence: true, pipelineStage: STAGE_SELECT },
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
   * Everything exchanged with the person behind an enquiry, oldest first —
   * leads:read (slice 3.3c).
   *
   * 🔑 READ THROUGH THE VIEW, AS THE RUNTIME ROLE, INSIDE THE TENANT
   * TRANSACTION. `person_timeline` is `security_invoker`, so it runs as
   * `eva_app` with `app.current_org` set and the policies on `messages` and
   * `activities` apply — which is the whole of its security (migration
   * 0041). `$queryRaw` because Prisma's `views` preview stays off; the
   * parameter is bound, never interpolated.
   *
   * ⚠️ AN ENQUIRY WITH NO PERSON HAS AN EMPTY TIMELINE, NOT AN ERROR. A
   * hand-logged lead carries a typed handle and no proof of control, so 3.3b
   * deliberately gave it no person. The screen says "nothing yet"; a 404 here
   * would read as the enquiry itself being missing.
   */
  /**
   * Everything exchanged with the person behind this enquiry, NEWEST first,
   * a page at a time (ruling 81) — the `person_timeline` view, through the
   * lead. Oldest-first was 3.3c's choice for a conversation read top-down;
   * at three hundred enquiries the latest message is what somebody opens
   * the page for, and the rest is a click away.
   *
   * ⚠️ THE CURSOR IS A PAIR, NOT A TIMESTAMP. WhatsApp stamps messages to
   * the second, so two items can share a `happened_at`; paging on the
   * timestamp alone would skip whichever of them fell on the boundary.
   * `(happened_at, item_id)` is what the ORDER BY sorts on, so it is what a
   * page ends on. One row more than asked for is fetched to know whether an
   * earlier page exists, and never returned.
   */
  async timeline(
    authUser: AuthUser,
    organisationId: string,
    leadId: string,
    query: LeadTimelineQuery,
  ): Promise<TimelinePage> {
    const user = await this.usersService.resolveOrProvision(authUser);
    return withTenant(this.prisma.db, { organisationId, userId: user.id }, async (tx) => {
      await requirePermission(tx, organisationId, user.id, "leads:read");
      const lead = await tx.lead.findFirst({
        where: { id: leadId, deletedAt: null },
        select: { personId: true },
      });
      if (!lead) throw new NotFoundException("Lead not found");
      if (!lead.personId) return { items: [], hasEarlier: false };

      const before = query.before ?? null;
      const beforeId = query.beforeId ?? null;
      const rows = await tx.$queryRaw<TimelineRow[]>`
        SELECT "item_type", "item_id", "channel", "detail", "actor_kind", "subject",
               "summary", "conversation_id", "lead_id", "happened_at"
        FROM "person_timeline"
        WHERE "person_id" = ${lead.personId}::uuid
          AND (${before}::timestamptz IS NULL
               OR ("happened_at", "item_id") < (${before}::timestamptz, ${beforeId}::uuid))
        ORDER BY "happened_at" DESC, "item_id" DESC
        LIMIT ${query.limit + 1}`;

      const page = rows.slice(0, query.limit);
      return {
        items: page.map((row) => ({
          id: row.item_id,
          type: row.item_type,
          channel: row.channel,
          detail: row.detail,
          actorKind: row.actor_kind,
          subject: row.subject,
          summary: row.summary,
          conversationId: row.conversation_id,
          leadId: row.lead_id,
          happenedAt: row.happened_at,
        })),
        hasEarlier: rows.length > query.limit,
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
      /**
       * Every writer supplies a stage (3.3b) — this one too, though no screen
       * reaches it any more. A person is NOT made here: a handle somebody
       * typed is unproven (blueprint §3.3 step 3), and the spine only links on
       * a message that actually arrived from the handle.
       */
      const stages = await ensureSystemStages(tx, organisationId);
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
          pipelineStageId: stages.new,
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
        include: { evidence: true, pipelineStage: STAGE_SELECT },
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
        include: { evidence: { select: { id: true } }, pipelineStage: STAGE_SELECT },
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
/** The stage columns every lead read carries, for `toSummary`. */
const STAGE_SELECT = { select: { systemKey: true, name: true } } as const;

type LeadWhere = NonNullable<NonNullable<Parameters<TenantTx["lead"]["findMany"]>[0]>["where"]>;

/**
 * The book's filters as one `where`, shared by the page, the count, the
 * stage tabs and the CSV so the four can never disagree about what "the
 * WhatsApp ones you searched for" means.
 */
function leadBookWhere(query: Omit<LeadListQuery, "limit" | "offset">): LeadWhere {
  const where: LeadWhere = { deletedAt: null };
  if (query.stage) where.pipelineStage = { systemKey: query.stage };
  if (query.channel) where.source = { in: [...LEAD_SOURCES_BY_CHANNEL[query.channel]] };
  if (query.answered === "yes") where.firstRespondedAt = { not: null };
  if (query.answered === "no") where.firstRespondedAt = null;
  if (query.search) {
    where.OR = [
      { contactName: { contains: query.search, mode: "insensitive" } },
      { contactEmail: { contains: query.search, mode: "insensitive" } },
      { contactPhone: { contains: query.search } },
      { enquiry: { contains: query.search, mode: "insensitive" } },
    ];
  }
  return where;
}

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
  pipelineStage: { systemKey: string | null; name: string };
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
    stage: { key: lead.pipelineStage.systemKey, name: lead.pipelineStage.name },
  };
}
