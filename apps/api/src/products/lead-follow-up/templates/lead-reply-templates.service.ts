import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { withTenant } from "@eva/database";
import {
  isReplyChannel,
  MAX_LEAD_REPLY_TEMPLATES,
  REPLY_CHANNEL_LABELS,
  REPLY_CHANNELS,
} from "@eva/types";
import type { LeadReplyTemplateDto, LeadReplyTemplatesDto, ReplyChannel } from "@eva/types";
import type { CreateLeadReplyTemplateInput, UpdateLeadReplyTemplateInput } from "@eva/validation";
// Value import is intentional: NestJS DI reads design:paramtypes metadata,
// which requires the class reference at runtime (not a type-only import).
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PrismaService } from "../../../common/database/prisma.service.js";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { UsersService } from "../../../platform/users/users.service.js";
import { requirePermission, type TenantTx } from "../../../platform/permissions/permissions.js";
import { writeAuditLog } from "../../../platform/audit/audit-log.js";
import type { AuthUser } from "../../../platform/authentication/current-auth-user.decorator.js";
import { DEFAULT_LEAD_REPLY_TEMPLATES } from "./default-templates.js";

/**
 * The wordings a customer replies to enquiries with (slice 3.1c-1).
 *
 * ⚠️ THIS SERVICE OWNS THE ONLY TABLE THE LEAD PRODUCT HAS. Everything else it
 * touches — the lead, the mailbox — belongs to the platform or to a capability
 * and is read, never owned. `architecture.spec.ts` enforces the difference.
 *
 * ⚠️ READING IS `leads:read`; EVERY WRITE IS `lead_templates:manage`, WHICH IS
 * OWNER ONLY. Founder ruling 2026-09-01, *"owner only for templates"* — and it
 * excludes `administrator` too, which is why that role's permission list names
 * the exception explicitly instead of inheriting the key.
 *
 * I built this on `leads:write` first and raised the consequence: that key is
 * held by sales and reception, so a receptionist could have rewritten the
 * message that goes out unread to every stranger who enquires. The founder
 * closed it.
 *
 * ⚠️ THE READ IS DELIBERATELY LEFT WIDE. Sales and reception still need to SEE
 * the wordings, or the "send one by hand from an enquiry" half of the product
 * (3.1c-4) is shut to exactly the people whose job it is.
 */
@Injectable()
export class LeadReplyTemplatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly usersService: UsersService,
  ) {}

  /** GET .../lead-reply-templates — `leads:read`. Seeds the three defaults on
   *  the first ever read (see `ensureDefaultTemplates`); reads are not audited. */
  async list(authUser: AuthUser, organisationId: string): Promise<LeadReplyTemplatesDto> {
    const user = await this.usersService.resolveOrProvision(authUser);
    return withTenant(this.prisma.db, { organisationId, userId: user.id }, async (tx) => {
      await requirePermission(tx, organisationId, user.id, "leads:read");
      await ensureDefaultTemplates(tx, organisationId, user.id);
      return toListDto(await liveTemplates(tx));
    });
  }

  /** POST .../lead-reply-templates — `leads:write`. */
  async create(
    authUser: AuthUser,
    organisationId: string,
    input: CreateLeadReplyTemplateInput,
  ): Promise<LeadReplyTemplateDto> {
    const user = await this.usersService.resolveOrProvision(authUser);
    return withTenant(this.prisma.db, { organisationId, userId: user.id }, async (tx) => {
      await requirePermission(tx, organisationId, user.id, "lead_templates:manage");
      /**
       * ⚠️ SEEDED FIRST, EVEN ON A WRITE. Without this, a customer whose very
       * first action is "add my own wording" ends up with one template and no
       * automatic reply at all — and then the three defaults appear around it
       * the next time somebody opens the screen, which reads like a bug.
       */
      await ensureDefaultTemplates(tx, organisationId, user.id);

      /**
       * ⚠️ THE CAP IS PER CHANNEL (slice 3.2b), NOT PER ORGANISATION. Counting
       * across channels would let a customer's email wordings use up the budget
       * for their WhatsApp ones — so connecting a second channel could refuse
       * the very first wording written for it, with a message about deleting
       * something the customer would find on a different screen.
       */
      const liveCount = await tx.leadReplyTemplate.count({
        where: { channel: input.channel, deletedAt: null },
      });
      if (liveCount >= MAX_LEAD_REPLY_TEMPLATES) {
        throw new ConflictException(
          `You can keep up to ${MAX_LEAD_REPLY_TEMPLATES} ${REPLY_CHANNEL_LABELS[input.channel]} reply templates. Delete one you no longer use to add another.`,
        );
      }
      await this.refuseDuplicateName(tx, input.channel, input.name, null);

      /**
       * ⚠️ THE DEMOTION HAS TO HAPPEN BEFORE THE INSERT, NOT AFTER IT.
       * `lead_reply_templates_single_automatic_key` is checked per statement:
       * inserting a second automatic row and tidying up afterwards fails on the
       * insert, inside the transaction, with a constraint name for an error.
       */
      if (input.isAutomatic) await demoteAutomatic(tx, input.channel);

      const created = await tx.leadReplyTemplate.create({
        data: {
          organisationId,
          channel: input.channel,
          name: input.name,
          body: input.body,
          isAutomatic: input.isAutomatic,
          createdBy: user.id,
        },
      });
      await writeAuditLog(tx, {
        organisationId,
        actorUserId: user.id,
        action: "lead_reply_template.created",
        entityType: "lead_reply_template",
        entityId: created.id,
        // The NAME, never the body: an audit row is not the place to keep a
        // second copy of every wording a customer has ever typed.
        metadata: {
          channel: created.channel,
          name: created.name,
          isAutomatic: created.isAutomatic,
        },
      });
      return toDto(created);
    });
  }

  /** PATCH .../lead-reply-templates/:templateId — `leads:write`. */
  async update(
    authUser: AuthUser,
    organisationId: string,
    templateId: string,
    input: UpdateLeadReplyTemplateInput,
  ): Promise<LeadReplyTemplateDto> {
    const user = await this.usersService.resolveOrProvision(authUser);
    return withTenant(this.prisma.db, { organisationId, userId: user.id }, async (tx) => {
      await requirePermission(tx, organisationId, user.id, "lead_templates:manage");
      const template = await tx.leadReplyTemplate.findFirst({
        where: { id: templateId, deletedAt: null },
      });
      if (!template) throw new NotFoundException("Reply template not found");

      /**
       * ⚠️ THE CHANNEL COMES FROM THE STORED ROW, NEVER FROM THE REQUEST, AND
       * THERE IS NO WAY TO CHANGE IT. A wording is written FOR a medium — the
       * email default's "replying to this email is the quickest way to reach
       * us" is nonsense on WhatsApp — so moving one between channels would
       * silently make it wrong rather than merely misfiled. Delete and rewrite
       * is the honest path, and it is what `UpdateLeadReplyTemplateInput`
       * allows by omitting the field entirely.
       */
      const channel = asReplyChannel(template.channel);

      if (input.name !== undefined) {
        await this.refuseDuplicateName(tx, channel, input.name, template.id);
      }

      /**
       * ⚠️ PROMOTING ONE DEMOTES THE OTHER, AND THAT IS THE WHOLE OF RULING 55.
       * There is no separate "unset the previous automatic" call — a customer
       * pressing "Eva sends this one" means exactly that, and making them
       * unset the old one first would leave a window where Eva replies with
       * nothing.
       *
       * ⚠️ AND IT DEMOTES ONLY THIS CHANNEL'S. See `demoteAutomatic`.
       */
      if (input.isAutomatic === true && !template.isAutomatic) await demoteAutomatic(tx, channel);

      const updated = await tx.leadReplyTemplate.update({
        where: { id: template.id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.body !== undefined ? { body: input.body } : {}),
          ...(input.isAutomatic !== undefined ? { isAutomatic: input.isAutomatic } : {}),
        },
      });
      await writeAuditLog(tx, {
        organisationId,
        actorUserId: user.id,
        action: "lead_reply_template.updated",
        entityType: "lead_reply_template",
        entityId: template.id,
        metadata: {
          changedFields: Object.keys(input).filter(
            (key) => input[key as keyof UpdateLeadReplyTemplateInput] !== undefined,
          ),
          /**
           * ⚠️ RECORDED SEPARATELY BECAUSE IT IS THE ONE CHANGE WITH AN OUTSIDE
           * EFFECT. Renaming a template changes a label; turning automation on
           * or off changes what a stranger receives, and "changedFields
           * included isAutomatic" does not say which way it went.
           */
          ...(input.isAutomatic !== undefined ? { isAutomatic: input.isAutomatic } : {}),
        },
      });
      return toDto(updated);
    });
  }

  /** DELETE .../lead-reply-templates/:templateId — `leads:write`. Soft. */
  async remove(authUser: AuthUser, organisationId: string, templateId: string): Promise<void> {
    const user = await this.usersService.resolveOrProvision(authUser);
    await withTenant(this.prisma.db, { organisationId, userId: user.id }, async (tx) => {
      await requirePermission(tx, organisationId, user.id, "lead_templates:manage");
      const template = await tx.leadReplyTemplate.findFirst({
        where: { id: templateId, deletedAt: null },
      });
      if (!template) throw new NotFoundException("Reply template not found");

      /**
       * ⚠️ THE AUTOMATIC ONE CANNOT BE DELETED, AND THIS IS THE ONE RULE HERE
       * WORTH ARGUING WITH.
       *
       * Deleting it would stop Eva answering enquiries — silently, from the
       * enquirer's side, and with nothing on screen afterwards that looks
       * different from a customer who chose to switch automation off. The
       * refusal makes that a decision somebody takes on purpose: turn the
       * automatic reply off (or promote another wording), and then delete.
       *
       * The alternative — allow it, and let `automaticTemplateIds[channel]` go null —
       * was rejected because the two states are indistinguishable afterwards
       * and only one of them was intended.
       */
      if (template.isAutomatic) {
        throw new BadRequestException(
          "This is the reply Eva sends automatically. Choose a different automatic reply, or turn the automatic reply off, before deleting this one.",
        );
      }

      await tx.leadReplyTemplate.update({
        where: { id: template.id },
        data: { deletedAt: new Date() },
      });
      await writeAuditLog(tx, {
        organisationId,
        actorUserId: user.id,
        action: "lead_reply_template.deleted",
        entityType: "lead_reply_template",
        entityId: template.id,
        metadata: { name: template.name },
      });
    });
  }

  /**
   * ⚠️ CHECKED HERE AS WELL AS AT THE DATABASE, FOR THE MESSAGE. The partial
   * unique index is what makes duplicates impossible; this is what makes the
   * refusal a sentence a customer can act on rather than a 500 carrying an
   * index name. Case-insensitive, because the index is on `lower(name)`.
   */
  private async refuseDuplicateName(
    tx: TenantTx,
    channel: ReplyChannel,
    name: string,
    exceptId: string | null,
  ): Promise<void> {
    const clash = await tx.leadReplyTemplate.findFirst({
      where: {
        /**
         * ⚠️ SCOPED TO THE CHANNEL, MATCHING THE INDEX IT MIRRORS. Without this
         * a customer could not call their WhatsApp wording "Standard reply"
         * because their EMAIL one already is — and the refusal would name a
         * template they cannot see from the screen they are on.
         */
        channel,
        deletedAt: null,
        name: { equals: name, mode: "insensitive" },
        ...(exceptId ? { id: { not: exceptId } } : {}),
      },
      select: { id: true },
    });
    if (clash) {
      throw new ConflictException(
        `You already have a ${REPLY_CHANNEL_LABELS[channel]} reply template called “${name}”.`,
      );
    }
  }
}

/**
 * The three defaults, created the first time an organisation ever looks.
 *
 * ⚠️ "NEVER HAD ONE", NOT "HAS NONE RIGHT NOW" — and the difference is the
 * whole design. Counting only LIVE rows would re-create all three every time a
 * customer emptied the list, so deleting the last template would be an action
 * the product silently undid. Counting every row, deleted included, means the
 * seed happens once in an organisation's life and a cleared list stays cleared.
 *
 * ⚠️ THIS IS A WRITE ON A READ, DELIBERATELY, AND IT HAS A PRECEDENT.
 * `ensureDefaultSequence` does exactly this for the invoice chaser's reminder
 * steps. The alternative — seeding when the product is switched on — would need
 * `platform/entitlements` to call into a product, which is the inversion
 * `architecture.spec.ts` exists to prevent, for a convenience nobody asked for.
 *
 * Idempotent under a race: two simultaneous first reads both see zero, both
 * insert, and `lead_reply_templates_live_name_key` fails the loser's
 * transaction rather than leaving six templates. A retried request then finds
 * three and does nothing.
 */
export async function ensureDefaultTemplates(
  tx: TenantTx,
  organisationId: string,
  actorUserId: string,
): Promise<void> {
  /**
   * ⚠️ PER CHANNEL, AND THE LOOP IS WHY A NEW CHANNEL NEEDS NO CODE HERE
   * (slice 3.2b). An organisation that has used email for a year has never seen
   * WhatsApp, so its WhatsApp count is zero and its wordings seed on first
   * sight — exactly as email's did. A single organisation-wide check would have
   * left every existing customer with no WhatsApp wordings at all, permanently,
   * because they had "already been seeded".
   */
  for (const channel of REPLY_CHANNELS) {
    /**
     * ⚠️ "NEVER HAD ONE", NOT "HAS NONE RIGHT NOW" — no `deletedAt` filter, on
     * purpose. Counting live rows only would re-create the defaults every time
     * a customer emptied a channel's list, so deleting the last wording would
     * be an action the product silently undid. This is the rule an earlier
     * version of this file got wrong while 22 tests stayed green: they deleted
     * one of three, so the count never reached zero and the two rules are
     * indistinguishable until a list is actually emptied.
     */
    const everHadOne = await tx.leadReplyTemplate.count({ where: { channel } });
    if (everHadOne > 0) continue;

    const defaults = DEFAULT_LEAD_REPLY_TEMPLATES[channel];
    await tx.leadReplyTemplate.createMany({
      data: defaults.map((template) => ({
        organisationId,
        channel,
        name: template.name,
        body: template.body,
        isAutomatic: template.isAutomatic,
        /**
         * ⚠️ THE PERSON WHO OPENED THE SCREEN DID NOT WRITE THESE. `created_by`
         * is who to ask about a wording, and answering "you did" about text we
         * shipped would be wrong the first time somebody uses the audit trail to
         * find out where a sentence came from.
         */
        createdBy: null,
      })),
    });
    await writeAuditLog(tx, {
      organisationId,
      actorUserId,
      action: "lead_reply_template.defaults_seeded",
      entityType: "lead_reply_template",
      // The channel, so the trail says WHICH set of wordings appeared and when.
      metadata: { channel, count: defaults.length },
    });
  }
}

/**
 * Clears whichever template currently carries the automatic flag.
 *
 * An `updateMany` over "the automatic ones" rather than a read-then-write:
 * there is at most one by construction, and asking the database to clear the
 * set is both one round trip and correct if the invariant is ever violated by
 * something that did not come through here.
 */
/**
 * 🚨 THE `channel` FILTER IS LOAD-BEARING, NOT TIDINESS (slice 3.2b).
 *
 * Without it, promoting a WhatsApp wording would silently switch OFF the
 * customer's email automatic reply — and nothing would look wrong: no error, no
 * constraint violation, one screen showing exactly what was asked for. Email
 * enquiries would simply stop being answered, and the first anyone would know is
 * a customer asking why a stranger never heard back.
 *
 * The database cannot catch this one. `lead_reply_templates_single_automatic_key`
 * refuses a SECOND automatic reply on a channel; it has nothing to say about
 * clearing one that should have been left alone.
 */
async function demoteAutomatic(tx: TenantTx, channel: ReplyChannel): Promise<void> {
  await tx.leadReplyTemplate.updateMany({
    where: { channel, isAutomatic: true, deletedAt: null },
    data: { isAutomatic: false },
  });
}

async function liveTemplates(tx: TenantTx) {
  return await tx.leadReplyTemplate.findMany({
    where: { deletedAt: null },
    /**
     * Channel first, so a customer's wordings arrive grouped rather than
     * interleaved; then the automatic one — it is the one that matters and the
     * one a customer came to check — then alphabetically, so the list does not
     * reshuffle itself every time somebody edits a wording.
     */
    orderBy: [{ channel: "asc" }, { isAutomatic: "desc" }, { name: "asc" }],
  });
}

type TemplateRow = Awaited<ReturnType<typeof liveTemplates>>[number];

function toDto(row: TemplateRow): LeadReplyTemplateDto {
  return {
    id: row.id,
    channel: asReplyChannel(row.channel),
    name: row.name,
    body: row.body,
    isAutomatic: row.isAutomatic,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * ⚠️ THE COLUMN IS A `TEXT`, SO SOMETHING HAS TO NARROW IT, AND A CAST WOULD
 * LIE. The database CHECK and `REPLY_CHANNELS` are two halves of one list, and
 * the day they disagree is the day a row arrives that no screen can render. A
 * throw here turns that into a loud failure on the read, rather than a
 * `channel` the web silently drops out of its grouping.
 */
function asReplyChannel(value: string): ReplyChannel {
  if (!isReplyChannel(value)) {
    throw new Error(
      `lead_reply_templates.channel holds ${value}, which is not a known reply channel — the database CHECK and REPLY_CHANNELS have diverged`,
    );
  }
  return value;
}

function toListDto(rows: TemplateRow[]): LeadReplyTemplatesDto {
  /**
   * ⚠️ ONE ENTRY PER CHANNEL, ALWAYS, INCLUDING THE NULLS. A channel with no
   * automatic reply is a real and important state — it is what the screen's red
   * warning is for — and leaving the key out would make "no automatic reply"
   * and "no such channel" the same shape to every caller.
   */
  const automaticTemplateIds = Object.fromEntries(
    REPLY_CHANNELS.map((channel) => [
      channel,
      rows.find((row) => row.channel === channel && row.isAutomatic)?.id ?? null,
    ]),
  ) as Record<ReplyChannel, string | null>;

  return { templates: rows.map(toDto), automaticTemplateIds };
}
