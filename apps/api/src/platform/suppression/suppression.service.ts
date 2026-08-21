import { Injectable, NotFoundException } from "@nestjs/common";
import { withTenant } from "@eva/database";
import type { CorrectSuppressionRequest } from "@eva/validation";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PrismaService } from "../../common/database/prisma.service.js";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { UsersService } from "../users/users.service.js";
import { requirePermission } from "../permissions/permissions.js";
import { writeAuditLog } from "../audit/audit-log.js";
import type { AuthUser } from "../authentication/current-auth-user.decorator.js";
import { correctSuppression, listSuppressed, normaliseSuppressionValue } from "./suppression.js";

/** One person Eva is not contacting, as a screen reads it. */
export interface SuppressionRow {
  channel: string;
  value: string;
  since: Date;
  reason: string | null;
  /** Who recorded it, resolved to a name the screen can print. */
  recordedBy: string | null;
}

/**
 * The do-not-contact record, and the correction path (2026-08-21).
 *
 * ⚠️ `suppression:manage` GUARDS BOTH READING AND CORRECTING, AND IT IS NOT
 * `leads:write`. Sales and reception press the do-not-contact button; owners and
 * administrators are who can say one was a mistake. Making undoing a different
 * permission from doing is the entire safeguard — if the person who mis-clicked
 * could also erase it, the record would only be as trustworthy as their
 * embarrassment.
 */
@Injectable()
export class SuppressionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly usersService: UsersService,
  ) {}

  /** Everyone this organisation is not contacting, newest first. */
  async list(authUser: AuthUser, organisationId: string): Promise<SuppressionRow[]> {
    const user = await this.usersService.resolveOrProvision(authUser);
    return withTenant(this.prisma.db, { organisationId, userId: user.id }, async (tx) => {
      await requirePermission(tx, organisationId, user.id, "suppression:manage");

      const entries = await listSuppressed(tx, organisationId);
      const actorIds = [
        ...new Set(entries.map((entry) => entry.actorUserId).filter((id): id is string => !!id)),
      ];
      /**
       * ⚠️ ONE QUERY FOR THE NAMES, NOT ONE PER ROW. The same N+1 the invoice
       * book was fixed for. A do-not-contact list is short today and there is
       * no reason to build in the version that is not.
       *
       * ⚠️ A NAME CAN COME BACK MISSING, AND THAT IS THE RLS DOING ITS JOB.
       * `users` is readable as "yourself, plus members of the active tenant",
       * so somebody who has since left the organisation resolves to null and
       * the screen says "someone who has left" rather than leaking a name from
       * outside the tenant. The event itself is never lost — only the label.
       */
      const names = new Map(
        (
          await tx.user.findMany({
            where: { id: { in: actorIds } },
            select: { id: true, fullName: true, email: true },
          })
        ).map((row) => [row.id, row.fullName ?? row.email]),
      );

      return entries.map((entry) => ({
        channel: entry.channel,
        value: entry.value,
        since: entry.since,
        reason: entry.reason,
        recordedBy: entry.actorUserId ? (names.get(entry.actorUserId) ?? null) : null,
      }));
    });
  }

  /**
   * "This was recorded in error" — supersedes an entry without deleting it.
   *
   * ⚠️ A 404 WHEN THE VALUE IS NOT CURRENTLY SUPPRESSED, INCLUDING WHEN IT WAS
   * ALREADY CORRECTED. Two people acting on the same row, or one person
   * double-submitting, must not stack two corrections — and telling the second
   * one "there is nothing here to correct" is truthful, where a silent success
   * would let them believe they did something.
   */
  async correct(
    authUser: AuthUser,
    organisationId: string,
    input: CorrectSuppressionRequest,
  ): Promise<{ corrected: true }> {
    const user = await this.usersService.resolveOrProvision(authUser);
    return withTenant(this.prisma.db, { organisationId, userId: user.id }, async (tx) => {
      await requirePermission(tx, organisationId, user.id, "suppression:manage");

      const corrected = await correctSuppression(tx, {
        organisationId,
        channel: input.channel,
        value: input.value,
        reason: input.reason,
        createdBy: user.id,
      });
      if (!corrected) {
        throw new NotFoundException("That is not currently a do-not-contact entry");
      }

      await writeAuditLog(tx, {
        organisationId,
        actorUserId: user.id,
        action: "suppression.corrected",
        entityType: "suppression",
        /**
         * ⚠️ THE VALUE IS THE ENTITY, BECAUSE THE ENTITY HAS NO STABLE ID. The
         * log is a sequence of events about a value, not a record with a
         * lifetime, so the address or number IS what was acted on. It is
         * already in `suppression_events` in the same organisation's rows, so
         * this puts nothing new in front of anyone.
         */
        entityId: normaliseSuppressionValue(input.channel, input.value),
        // ⚠️ THE REASON IS THE POINT OF THIS ENTRY. "Somebody undid a
        // do-not-contact" without why is a line that raises a question and
        // answers none.
        metadata: { channel: input.channel, reason: input.reason },
      });

      return { corrected: true };
    });
  }
}
