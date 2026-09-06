import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { withTenant } from "@eva/database";
import {
  LEAD_PLAYBOOK_LABELS,
  LEAD_PLAYBOOKS_BUILT,
  REPLY_CHANNELS,
  isReplyChannel,
  type LeadPlaybookBuiltKey,
  type LeadPlaybookDto,
  type LeadPlaybooksDto,
  type LeadPlaybookWordingDto,
  type ReplyChannel,
} from "@eva/types";
import type { SaveLeadPlaybookWordingInput, UpdateLeadPlaybookInput } from "@eva/validation";
// Value import is intentional: NestJS DI reads design:paramtypes metadata,
// which requires the class reference at runtime (not a type-only import).
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PrismaService } from "../../../common/database/prisma.service.js";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { UsersService } from "../../../platform/users/users.service.js";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { MailboxesService } from "../../../capabilities/mailbox/mailboxes.service.js";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { WhatsAppNumbersService } from "../../../capabilities/messaging/whatsapp-numbers.service.js";
import { parseBusinessHours } from "../../../platform/organisations/opening-hours.js";
import { requirePermission, type TenantTx } from "../../../platform/permissions/permissions.js";
import { writeAuditLog } from "../../../platform/audit/audit-log.js";
import type { AuthUser } from "../../../platform/authentication/current-auth-user.decorator.js";
import { DEFAULT_LEAD_PLAYBOOK_WORDINGS } from "./default-wordings.js";

/**
 * The things Eva does on her own, as cards with switches (slice 3.5a, ruling
 * 93; the successor of the templates service of 3.1c-1).
 *
 * 🔑 A CARD IS A SWITCH PLUS ONE WORDING PER CHANNEL. The switch is a
 * `lead_playbooks` row; the wording is a `lead_reply_templates` row bound to
 * the card by `playbook_key`. There is no list of named wordings any more:
 * "Add another reply", the pill and the ten-per-channel cap went with ruling
 * 93, because a wording bound to no behaviour was one nothing read.
 *
 * ⚠️ READING IS `leads:read`; EVERY WRITE IS `lead_templates:manage`, WHICH IS
 * OWNER ONLY (founder ruling 2026-09-01, unchanged). A switch decides whether
 * a stranger hears back at all, and the wording decides what they read in the
 * business's name; both are the owner's.
 *
 * ⚠️ THE CARDS THAT DO NOT EXIST YET ARE NOT HERE. `LEAD_PLAYBOOKS_BUILT` is
 * the list this service seeds, returns and switches; the database admits
 * three more keys for the slices that run them. A switch on a card nothing
 * runs would be a promise the screen cannot keep.
 */
@Injectable()
export class LeadPlaybooksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly usersService: UsersService,
    private readonly mailboxes: MailboxesService,
    private readonly numbers: WhatsAppNumbersService,
  ) {}

  /** GET .../lead-playbooks — `leads:read`. Seeds the cards on first sight. */
  async list(authUser: AuthUser, organisationId: string): Promise<LeadPlaybooksDto> {
    const user = await this.usersService.resolveOrProvision(authUser);
    return withTenant(this.prisma.db, { organisationId, userId: user.id }, async (tx) => {
      await requirePermission(tx, organisationId, user.id, "leads:read");
      await ensureDefaultPlaybooks(tx, organisationId, user.id);
      return await this.read(tx, organisationId);
    });
  }

  /**
   * PATCH .../lead-playbooks/:key — the switch. `lead_templates:manage`.
   *
   * ⚠️ THE OUT-OF-HOURS CARD CANNOT BE SWITCHED ON WITHOUT OPENING HOURS. Its
   * whole behaviour is "when you are closed", and an organisation that has
   * never said when that is would either never fire it or always fire it.
   * Refused with the sentence that says where to go, rather than a switch
   * that turns on and does nothing.
   */
  async setEnabled(
    authUser: AuthUser,
    organisationId: string,
    key: LeadPlaybookBuiltKey,
    input: UpdateLeadPlaybookInput,
  ): Promise<LeadPlaybookDto> {
    const user = await this.usersService.resolveOrProvision(authUser);
    return withTenant(this.prisma.db, { organisationId, userId: user.id }, async (tx) => {
      await requirePermission(tx, organisationId, user.id, "lead_templates:manage");
      await ensureDefaultPlaybooks(tx, organisationId, user.id);

      if (key === "after_hours" && input.enabled) {
        const settings = await tx.organisationSettings.findUnique({
          where: { organisationId },
          select: { businessHours: true },
        });
        if (!parseBusinessHours(settings?.businessHours)) {
          throw new ConflictException(
            "Set your opening hours first, so Eva knows when you are closed. They are under Settings.",
          );
        }
      }

      const row = await tx.leadPlaybook.findFirst({ where: { key, deletedAt: null } });
      if (!row) throw new NotFoundException("No such card");

      if (row.enabled !== input.enabled) {
        await tx.leadPlaybook.update({
          where: { id: row.id },
          data: { enabled: input.enabled },
        });
        await writeAuditLog(tx, {
          organisationId,
          actorUserId: user.id,
          action: input.enabled ? "lead_playbook.switched_on" : "lead_playbook.switched_off",
          entityType: "lead_playbook",
          entityId: row.id,
          // The key says WHICH behaviour changed; the action says which way.
          metadata: { key },
        });
      }

      const dto = (await this.read(tx, organisationId)).playbooks.find((p) => p.key === key);
      if (!dto) throw new NotFoundException("No such card");
      return dto;
    });
  }

  /**
   * PUT .../lead-playbooks/:key/wordings/:channel — the words in one box.
   * `lead_templates:manage`.
   *
   * ⚠️ A WORDING IS ADDRESSED BY WHERE IT GOES, AND IT CANNOT BE MOVED. The
   * card and the channel are in the path; the row's name is the card's name,
   * which the customer does not write. An old row of that name on that
   * channel with no card (a wording from before 3.5a) is bound rather than
   * duplicated, because `lead_reply_templates_live_name_key` is one name per
   * channel among the live rows and the honest reading is "this IS that
   * wording, now with a card".
   */
  async saveWording(
    authUser: AuthUser,
    organisationId: string,
    key: LeadPlaybookBuiltKey,
    channel: ReplyChannel,
    input: SaveLeadPlaybookWordingInput,
  ): Promise<LeadPlaybookWordingDto> {
    const user = await this.usersService.resolveOrProvision(authUser);
    return withTenant(this.prisma.db, { organisationId, userId: user.id }, async (tx) => {
      await requirePermission(tx, organisationId, user.id, "lead_templates:manage");
      await ensureDefaultPlaybooks(tx, organisationId, user.id);

      const bound = await tx.leadReplyTemplate.findFirst({
        where: { channel, playbookKey: key, deletedAt: null },
      });
      if (bound) {
        const updated = await tx.leadReplyTemplate.update({
          where: { id: bound.id },
          data: { body: input.body },
        });
        await writeAuditLog(tx, {
          organisationId,
          actorUserId: user.id,
          action: "lead_reply_template.updated",
          entityType: "lead_reply_template",
          entityId: bound.id,
          // The card and the channel, never the body: an audit row is not the
          // place to keep a second copy of every wording a customer typed.
          metadata: { playbookKey: key, channel },
        });
        return toWordingDto(updated);
      }

      const name = LEAD_PLAYBOOK_LABELS[key].name;
      const orphan = await tx.leadReplyTemplate.findFirst({
        where: {
          channel,
          deletedAt: null,
          playbookKey: null,
          name: { equals: name, mode: "insensitive" },
        },
      });
      const row = orphan
        ? await tx.leadReplyTemplate.update({
            where: { id: orphan.id },
            data: { body: input.body, playbookKey: key },
          })
        : await tx.leadReplyTemplate.create({
            data: {
              organisationId,
              channel,
              name,
              body: input.body,
              playbookKey: key,
              createdBy: user.id,
            },
          });
      await writeAuditLog(tx, {
        organisationId,
        actorUserId: user.id,
        action: "lead_reply_template.created",
        entityType: "lead_reply_template",
        entityId: row.id,
        metadata: { playbookKey: key, channel, name },
      });
      return toWordingDto(row);
    });
  }

  /**
   * DELETE .../lead-playbooks/:key/wordings/:channel — empty one box.
   * `lead_templates:manage`. Soft: a wording Eva has already sent from must
   * stay readable to the reply record that points at it (3.1c-3).
   *
   * ⚠️ THIS IS HOW A CUSTOMER SILENCES ONE CHANNEL. The switch is per card,
   * across channels; an empty box means Eva sends nothing on that channel for
   * that card and the record says so. The screen confirms before it happens.
   */
  async clearWording(
    authUser: AuthUser,
    organisationId: string,
    key: LeadPlaybookBuiltKey,
    channel: ReplyChannel,
  ): Promise<void> {
    const user = await this.usersService.resolveOrProvision(authUser);
    await withTenant(this.prisma.db, { organisationId, userId: user.id }, async (tx) => {
      await requirePermission(tx, organisationId, user.id, "lead_templates:manage");
      const bound = await tx.leadReplyTemplate.findFirst({
        where: { channel, playbookKey: key, deletedAt: null },
      });
      if (!bound) throw new NotFoundException("There is no wording in that box");
      await tx.leadReplyTemplate.update({
        where: { id: bound.id },
        data: { deletedAt: new Date() },
      });
      await writeAuditLog(tx, {
        organisationId,
        actorUserId: user.id,
        action: "lead_reply_template.cleared",
        entityType: "lead_reply_template",
        entityId: bound.id,
        metadata: { playbookKey: key, channel },
      });
    });
  }

  /** The screen in one read: the cards, where each channel sends from, and whether hours exist. */
  private async read(tx: TenantTx, organisationId: string): Promise<LeadPlaybooksDto> {
    const [switches, wordings, settings, sendsFrom] = await Promise.all([
      tx.leadPlaybook.findMany({ where: { deletedAt: null } }),
      tx.leadReplyTemplate.findMany({
        where: { deletedAt: null, playbookKey: { not: null } },
      }),
      tx.organisationSettings.findUnique({
        where: { organisationId },
        select: { businessHours: true },
      }),
      this.sendsFrom(tx, organisationId),
    ]);

    const playbooks: LeadPlaybookDto[] = LEAD_PLAYBOOKS_BUILT.map((key) => ({
      key,
      enabled: switches.find((row) => row.key === key)?.enabled ?? false,
      /**
       * ⚠️ EVERY CHANNEL PRESENT, NULL WHEN THE BOX IS EMPTY. "Eva is silent on
       * WhatsApp for this card" is a state a customer can choose, and it has
       * to stay a different shape from "no such channel".
       */
      wordings: Object.fromEntries(
        REPLY_CHANNELS.map((channel) => {
          const row = wordings.find((w) => w.playbookKey === key && w.channel === channel);
          return [channel, row ? toWordingDto(row) : null];
        }),
      ) as Record<ReplyChannel, LeadPlaybookWordingDto | null>,
    }));

    return {
      playbooks,
      sendsFrom,
      openingHoursSet: parseBusinessHours(settings?.businessHours) !== null,
    };
  }

  /**
   * Where each channel's replies leave from (ruling 89) — asked of the two
   * capabilities exactly the way the sender asks, so the screen and the send
   * can never disagree about what is "connected".
   */
  private async sendsFrom(
    tx: TenantTx,
    organisationId: string,
  ): Promise<LeadPlaybooksDto["sendsFrom"]> {
    const mailbox = await this.mailboxes.resolveSendingMailbox(
      tx,
      organisationId,
      "lead_follow_up",
      { organisationId, emailAccountId: null },
    );
    const number = await this.numbers.resolveSendingNumber(tx, organisationId, "lead_follow_up");
    return {
      email: mailbox ? { from: mailbox.account.emailAddress } : null,
      whatsapp: number ? { from: number.connection.displayName } : null,
    };
  }
}

/**
 * The cards and their words, created the first time an organisation ever
 * looks (the `ensureDefaultTemplates` rule of 3.1c-1, kept whole).
 *
 * ⚠️ "NEVER HAD ONE", NOT "HAS NONE RIGHT NOW". A switch is counted among ALL
 * rows, deleted included, per key; a channel's wordings are counted among all
 * rows per channel. Counting live rows only would re-create the defaults
 * every time a customer emptied a box, so clearing the last wording would be
 * an action the product silently undid.
 *
 * ⚠️ THE INSTANT REPLY SEEDS ON; EVERYTHING ELSE SEEDS OFF. It is the thing
 * the product has always done, and the old automatic wording was on for
 * every organisation that had one. The out-of-hours card needs opening hours
 * before it can be switched on at all.
 *
 * ⚠️ THIS IS A WRITE ON A READ, DELIBERATELY, AND IT IS NEVER RUN FROM A
 * WEBHOOK. A customer opening a screen is a person with a permission in a
 * request that is allowed to write; a stranger's message is not.
 */
export async function ensureDefaultPlaybooks(
  tx: TenantTx,
  organisationId: string,
  actorUserId: string,
): Promise<void> {
  for (const key of LEAD_PLAYBOOKS_BUILT) {
    const everHadOne = await tx.leadPlaybook.count({ where: { key } });
    if (everHadOne > 0) continue;
    const created = await tx.leadPlaybook.create({
      data: {
        organisationId,
        key,
        enabled: key === "instant_reply",
        // Nobody pressed this. `created_by` is who to ask about a switch.
        createdBy: null,
      },
    });
    await writeAuditLog(tx, {
      organisationId,
      actorUserId,
      action: "lead_playbook.defaults_seeded",
      entityType: "lead_playbook",
      entityId: created.id,
      metadata: { key, enabled: created.enabled },
    });
  }

  for (const channel of REPLY_CHANNELS) {
    const everHadOne = await tx.leadReplyTemplate.count({ where: { channel } });
    if (everHadOne > 0) continue;
    await tx.leadReplyTemplate.createMany({
      data: LEAD_PLAYBOOKS_BUILT.map((key) => ({
        organisationId,
        channel,
        name: LEAD_PLAYBOOK_LABELS[key].name,
        body: DEFAULT_LEAD_PLAYBOOK_WORDINGS[key][channel],
        playbookKey: key,
        // The person who opened the screen did not write these.
        createdBy: null,
      })),
    });
    await writeAuditLog(tx, {
      organisationId,
      actorUserId,
      action: "lead_reply_template.defaults_seeded",
      entityType: "lead_reply_template",
      metadata: { channel, count: LEAD_PLAYBOOKS_BUILT.length },
    });
  }
}

interface WordingRow {
  id: string;
  channel: string;
  body: string;
  updatedAt: Date;
}

function toWordingDto(row: WordingRow): LeadPlaybookWordingDto {
  return {
    id: row.id,
    channel: asReplyChannel(row.channel),
    body: row.body,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * ⚠️ THE COLUMN IS A `TEXT`, SO SOMETHING HAS TO NARROW IT, AND A CAST WOULD
 * LIE. The database CHECK and `REPLY_CHANNELS` are two halves of one list; a
 * throw here turns their divergence into a loud failure on the read.
 */
function asReplyChannel(value: string): ReplyChannel {
  if (!isReplyChannel(value)) {
    throw new Error(
      `lead_reply_templates.channel holds ${value}, which is not a known reply channel — the database CHECK and REPLY_CHANNELS have diverged`,
    );
  }
  return value;
}
