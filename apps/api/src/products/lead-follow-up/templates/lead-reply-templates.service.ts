import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { withTenant } from "@eva/database";
import { MAX_LEAD_REPLY_TEMPLATES } from "@eva/types";
import type { LeadReplyTemplateDto, LeadReplyTemplatesDto } from "@eva/types";
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

      const liveCount = await tx.leadReplyTemplate.count({ where: { deletedAt: null } });
      if (liveCount >= MAX_LEAD_REPLY_TEMPLATES) {
        throw new ConflictException(
          `You can keep up to ${MAX_LEAD_REPLY_TEMPLATES} reply templates. Delete one you no longer use to add another.`,
        );
      }
      await this.refuseDuplicateName(tx, input.name, null);

      /**
       * ⚠️ THE DEMOTION HAS TO HAPPEN BEFORE THE INSERT, NOT AFTER IT.
       * `lead_reply_templates_single_automatic_key` is checked per statement:
       * inserting a second automatic row and tidying up afterwards fails on the
       * insert, inside the transaction, with a constraint name for an error.
       */
      if (input.isAutomatic) await demoteAutomatic(tx);

      const created = await tx.leadReplyTemplate.create({
        data: {
          organisationId,
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
        metadata: { name: created.name, isAutomatic: created.isAutomatic },
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

      if (input.name !== undefined) await this.refuseDuplicateName(tx, input.name, template.id);

      /**
       * ⚠️ PROMOTING ONE DEMOTES THE OTHER, AND THAT IS THE WHOLE OF RULING 55.
       * There is no separate "unset the previous automatic" call — a customer
       * pressing "Eva sends this one" means exactly that, and making them
       * unset the old one first would leave a window where Eva replies with
       * nothing.
       */
      if (input.isAutomatic === true && !template.isAutomatic) await demoteAutomatic(tx);

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
       * The alternative — allow it, and let `automaticTemplateId` go null —
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
    name: string,
    exceptId: string | null,
  ): Promise<void> {
    const clash = await tx.leadReplyTemplate.findFirst({
      where: {
        deletedAt: null,
        name: { equals: name, mode: "insensitive" },
        ...(exceptId ? { id: { not: exceptId } } : {}),
      },
      select: { id: true },
    });
    if (clash) {
      throw new ConflictException(`You already have a reply template called “${name}”.`);
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
  const everHadOne = await tx.leadReplyTemplate.count();
  if (everHadOne > 0) return;

  await tx.leadReplyTemplate.createMany({
    data: DEFAULT_LEAD_REPLY_TEMPLATES.map((template) => ({
      organisationId,
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
    metadata: { count: DEFAULT_LEAD_REPLY_TEMPLATES.length },
  });
}

/**
 * Clears whichever template currently carries the automatic flag.
 *
 * An `updateMany` over "the automatic ones" rather than a read-then-write:
 * there is at most one by construction, and asking the database to clear the
 * set is both one round trip and correct if the invariant is ever violated by
 * something that did not come through here.
 */
async function demoteAutomatic(tx: TenantTx): Promise<void> {
  await tx.leadReplyTemplate.updateMany({
    where: { isAutomatic: true, deletedAt: null },
    data: { isAutomatic: false },
  });
}

async function liveTemplates(tx: TenantTx) {
  return await tx.leadReplyTemplate.findMany({
    where: { deletedAt: null },
    /**
     * The automatic one first — it is the one that matters and the one a
     * customer came to check — then alphabetically, so the list does not
     * reshuffle itself every time somebody edits a wording.
     */
    orderBy: [{ isAutomatic: "desc" }, { name: "asc" }],
  });
}

type TemplateRow = Awaited<ReturnType<typeof liveTemplates>>[number];

function toDto(row: TemplateRow): LeadReplyTemplateDto {
  return {
    id: row.id,
    name: row.name,
    body: row.body,
    isAutomatic: row.isAutomatic,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toListDto(rows: TemplateRow[]): LeadReplyTemplatesDto {
  return {
    templates: rows.map(toDto),
    automaticTemplateId: rows.find((row) => row.isAutomatic)?.id ?? null,
  };
}
