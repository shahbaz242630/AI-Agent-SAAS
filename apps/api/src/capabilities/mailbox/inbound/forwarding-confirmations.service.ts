import { Inject, Injectable, NotFoundException } from "@nestjs/common";
// Value import is intentional: NestJS DI reads design:paramtypes metadata,
// which requires the class reference at runtime (not a type-only import).
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PinoLogger } from "nestjs-pino";
import { withTenant } from "@eva/database";
import { FORWARDING_ARMED_WINDOW_MINUTES } from "@eva/types";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PrismaService } from "../../../common/database/prisma.service.js";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { UsersService } from "../../../platform/users/users.service.js";
import { requirePermission, type TenantTx } from "../../../platform/permissions/permissions.js";
import { writeAuditLog } from "../../../platform/audit/audit-log.js";
import type { AuthUser } from "../../../platform/authentication/current-auth-user.decorator.js";
import {
  FORWARDING_CONFIRMER,
  ForwardingConfirmationError,
  type ForwardingConfirmer,
} from "./forwarding-confirmer.js";
import type { ForwardingConfirmation } from "./gmail-forwarding-confirmation.js";

/**
 * Who may forward mail into a customer's book (Slice 3.1b, step 4).
 *
 * ⚠️ THE WHOLE FILE IS ONE RULE: WE CONFIRM WHAT THE CUSTOMER ASKED FOR, AND WE
 * ASK ABOUT ANYTHING ELSE.
 *
 * The decision document says Eva confirms Gmail's forwarding request so the
 * customer never hunts for a code. That cannot mean confirming whatever asks.
 * Google's confirmation email is the second lock on a door whose first lock is
 * ruling 33's random tail — mail cannot be forwarded to an address until that
 * address's owner agrees, and the owner is us. Answering every request would
 * hand anyone who guesses an address a silent feed into that customer's
 * enquiries, and once 3.1c ships, a way to make Eva reply to strangers over
 * that customer's signature.
 *
 * So there is a WINDOW, opened by a signed-in user on the guided screen, and it
 * is short. Inside it, Eva answers. Outside it, the customer does.
 */

/**
 * ⚠️ LONG ON PURPOSE, AND MEASURED RATHER THAN GUESSED. Gmail sends its
 * confirmation the instant the address is entered, but the first real inbound
 * message of this slice took 1m52s to reach our webhook, and Google's own
 * confirmation email took rather longer than that on 2026-08-22. On top of the
 * delivery time sits a human reading instructions, finding Gmail's settings
 * (which render stale often enough that "reload the page" is in our own copy)
 * and typing an address.
 *
 * Thirty minutes is comfortably longer than all of that and far shorter than
 * the "forever" a permanent flag would give.
 *
 * ⚠️ RE-EXPORTED FROM THE SHARED KERNEL RATHER THAN DECLARED HERE. The guided
 * screen states this number in a sentence the customer reads before walking
 * off to Gmail; two copies of it is a screen promising half an hour while the
 * server allows ten minutes, and nothing anywhere failing.
 */
export const ARMED_WINDOW_MINUTES = FORWARDING_ARMED_WINDOW_MINUTES;

/** A forwarding request, as the guided screen reads it. */
export interface ForwardingRequestView {
  id: string;
  /** The mailbox that wants to forward here. */
  sourceAddress: string;
  status: "pending" | "confirmed" | "declined";
  /** Why our own attempt did not work, when one was made and did not. */
  failureReason: string | null;
  /**
   * ⚠️ THE FALLBACK, AND IT IS A LINK RATHER THAN A CODE BECAUSE GOOGLE NO
   * LONGER SENDS A CODE. Measured on the real message, 2026-08-22: there is no
   * confirmation code in the subject or the body, only this URL. A screen
   * offering "paste this code into Gmail" would be offering something that does
   * not exist.
   */
  confirmUrl: string | null;
  /** True when Eva answered it; false when a person did. Null while pending. */
  confirmedAutomatically: boolean | null;
  requestedAt: Date;
  settledAt: Date | null;
}

/** What the customer decided about a request Eva would not answer itself. */
export type ForwardingDecision = "confirm" | "decline";

@Injectable()
export class ForwardingConfirmationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly usersService: UsersService,
    @Inject(FORWARDING_CONFIRMER) private readonly confirmer: ForwardingConfirmer,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ForwardingConfirmationsService.name);
  }

  /**
   * "I am setting forwarding up now" — opens the window (`leads:write`).
   *
   * ⚠️ `leads:write` RATHER THAN `leads:read`, THOUGH THIS SCREEN IS MOSTLY
   * READING. Arming decides whose mail Eva will accept without asking. That is
   * a change to the customer's security posture, not a page view, and the role
   * that may only look at the book should not be able to make it.
   */
  async arm(authUser: AuthUser, organisationId: string): Promise<{ armedUntil: Date }> {
    const user = await this.usersService.resolveOrProvision(authUser);

    return withTenant(this.prisma.db, { organisationId, userId: user.id }, async (tx) => {
      await requirePermission(tx, organisationId, user.id, "leads:write");

      const address = await tx.inboundAddress.findFirst({
        where: { deletedAt: null },
        select: { id: true },
      });
      if (!address) {
        throw new NotFoundException("This organisation has no enquiry address to forward to yet");
      }

      const armedAt = new Date();
      await tx.inboundAddress.update({
        where: { id: address.id },
        data: { forwardingArmedAt: armedAt, forwardingArmedBy: user.id },
      });

      await writeAuditLog(tx, {
        organisationId,
        actorUserId: user.id,
        action: "inbound_address.forwarding_armed",
        entityType: "inbound_address",
        entityId: address.id,
        metadata: { minutes: ARMED_WINDOW_MINUTES },
      });

      return { armedUntil: new Date(armedAt.getTime() + ARMED_WINDOW_MINUTES * 60_000) };
    });
  }

  /**
   * Google asked whether somebody may forward mail here. Runs from the webhook,
   * so there is no acting user — the same shape the intake path uses.
   *
   * ⚠️ THE ROW IS WRITTEN BEFORE WE TRY TO ANSWER IT, FOR THE SAME REASON THE
   * DELIVERY IS WRITTEN BEFORE THE BODY IS FETCHED (#103). Confirming is a
   * network call to Google that can fail on its own; a failure with nothing
   * recorded is a customer staring at a screen that never moves, with no way to
   * finish the job by hand.
   */
  async record(
    organisationId: string,
    message: { id: string; inboundAddressId: string },
    confirmation: ForwardingConfirmation,
  ): Promise<void> {
    const prepared = await this.inTenant(organisationId, async (tx) => {
      const existing = await tx.inboundForwardingRequest.findFirst({
        where: { inboundMessageId: message.id },
        select: { id: true, status: true },
      });
      /**
       * ⚠️ A REPLAY UPDATES NOTHING. Gmail resends and webhooks retry; asking
       * the customer the same question twice — or re-confirming something they
       * declined — is worse than doing nothing.
       */
      if (existing) return null;

      const address = await tx.inboundAddress.findFirst({
        where: { id: message.inboundAddressId },
        select: { forwardingArmedAt: true },
      });

      const row = await tx.inboundForwardingRequest.create({
        data: {
          organisationId,
          inboundAddressId: message.inboundAddressId,
          inboundMessageId: message.id,
          sourceAddress: confirmation.sourceAddress.toLowerCase(),
          confirmationCode: confirmation.code,
          confirmationUrl: confirmation.confirmUrl,
          status: "pending",
        },
        select: { id: true },
      });

      /**
       * ⚠️ NO ACTOR, AND THE AUDIT LINE STILL MATTERS. Somebody asking to have
       * a customer's mail delivered elsewhere is worth a permanent record
       * whether or not it was expected — this is the line that explains, months
       * later, why a stranger's mail is in somebody's book.
       */
      await writeAuditLog(tx, {
        organisationId,
        actorUserId: null,
        action: "inbound_forwarding.requested",
        entityType: "inbound_forwarding_request",
        entityId: row.id,
        metadata: {
          sourceAddress: confirmation.sourceAddress.toLowerCase(),
          armed: isArmed(address?.forwardingArmedAt ?? null),
        },
      });

      return { id: row.id, armed: isArmed(address?.forwardingArmedAt ?? null) };
    });

    if (!prepared) return;

    if (!prepared.armed) {
      /**
       * ⚠️ NOT AN ERROR, AND NOT A DROP. Nobody told us to expect this, so it
       * waits for a human. We genuinely cannot tell a customer who set
       * forwarding up in another tab from somebody who guessed the address —
       * but THEY can, and the screen asks them.
       */
      this.logger.info(
        { organisationId, requestId: prepared.id },
        "a forwarding request arrived that nobody had armed; leaving it for the customer",
      );
      return;
    }

    if (!confirmation.confirmUrl) {
      await this.noteFailure(
        organisationId,
        prepared.id,
        "Google's email did not contain a confirmation link",
      );
      return;
    }

    await this.attemptConfirm(organisationId, prepared.id, confirmation.confirmUrl, null);
  }

  /** The guided screen's list, newest first (`leads:read`). */
  async list(authUser: AuthUser, organisationId: string): Promise<ForwardingRequestView[]> {
    const user = await this.usersService.resolveOrProvision(authUser);

    return withTenant(this.prisma.db, { organisationId, userId: user.id }, async (tx) => {
      await requirePermission(tx, organisationId, user.id, "leads:read");
      const rows = await tx.inboundForwardingRequest.findMany({
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          sourceAddress: true,
          status: true,
          failureReason: true,
          confirmationUrl: true,
          settledAt: true,
          settledBy: true,
          createdAt: true,
        },
      });
      return rows.map((row) => ({
        id: row.id,
        sourceAddress: row.sourceAddress,
        status: row.status as ForwardingRequestView["status"],
        failureReason: row.failureReason,
        confirmUrl: row.confirmationUrl,
        confirmedAutomatically: row.settledAt === null ? null : row.settledBy === null,
        requestedAt: row.createdAt,
        settledAt: row.settledAt,
      }));
    });
  }

  /**
   * "Yes, that was me" or "no, it wasn't" (`leads:write`).
   *
   * ⚠️ DECLINING DOES NOT TELL GOOGLE ANYTHING, AND MUST NOT PRETEND TO. There
   * is a cancel link in Google's email, and following it would be us cancelling
   * on the requester's behalf — a thing we were never asked to do. Declining
   * here means WE will not confirm it: without our confirmation Google never
   * starts forwarding, which is the outcome the customer wanted. The row stays
   * as the record that somebody asked.
   */
  async settle(
    authUser: AuthUser,
    organisationId: string,
    requestId: string,
    decision: ForwardingDecision,
  ): Promise<ForwardingRequestView> {
    const user = await this.usersService.resolveOrProvision(authUser);

    const request = await withTenant(
      this.prisma.db,
      { organisationId, userId: user.id },
      async (tx) => {
        await requirePermission(tx, organisationId, user.id, "leads:write");
        const row = await tx.inboundForwardingRequest.findFirst({
          where: { id: requestId },
          select: { id: true, status: true, confirmationUrl: true },
        });
        if (!row) throw new NotFoundException("No such forwarding request");
        return row;
      },
    );

    if (request.status !== "pending") {
      // Already answered. Idempotent rather than an error: two people on the
      // same screen must not produce a 409 neither of them can act on.
      return this.one(authUser, organisationId, requestId);
    }

    if (decision === "decline") {
      await this.markSettled(organisationId, requestId, "declined", user.id);
      return this.one(authUser, organisationId, requestId);
    }

    if (!request.confirmationUrl) {
      await this.noteFailure(
        organisationId,
        requestId,
        "Google's email did not contain a confirmation link",
      );
      return this.one(authUser, organisationId, requestId);
    }

    await this.attemptConfirm(organisationId, requestId, request.confirmationUrl, user.id);
    return this.one(authUser, organisationId, requestId);
  }

  /**
   * Answer Google, and write down what happened either way.
   *
   * ⚠️ A FAILURE LEAVES THE REQUEST PENDING RATHER THAN FAILING IT. The link is
   * still valid, the customer can still use it, and a row marked failed would
   * take that away from them for what may have been a five-second network blip.
   */
  private async attemptConfirm(
    organisationId: string,
    requestId: string,
    url: string,
    userId: string | null,
  ): Promise<void> {
    try {
      await this.confirmer.confirm(url);
    } catch (error) {
      const reason =
        error instanceof ForwardingConfirmationError
          ? error.message
          : "Google could not be reached";
      this.logger.warn({ organisationId, requestId, reason }, "could not confirm mail forwarding");
      await this.noteFailure(organisationId, requestId, reason);
      return;
    }
    await this.markSettled(organisationId, requestId, "confirmed", userId);
  }

  private async markSettled(
    organisationId: string,
    requestId: string,
    status: "confirmed" | "declined",
    userId: string | null,
  ): Promise<void> {
    await this.inTenant(organisationId, async (tx) => {
      await tx.inboundForwardingRequest.update({
        where: { id: requestId },
        data: { status, settledAt: new Date(), settledBy: userId, failureReason: null },
      });
      await writeAuditLog(tx, {
        organisationId,
        actorUserId: userId,
        action: `inbound_forwarding.${status}`,
        entityType: "inbound_forwarding_request",
        entityId: requestId,
        metadata: { automatic: userId === null },
      });
    });
  }

  private async noteFailure(
    organisationId: string,
    requestId: string,
    reason: string,
  ): Promise<void> {
    await this.inTenant(organisationId, (tx) =>
      tx.inboundForwardingRequest.update({
        where: { id: requestId },
        data: { failureReason: reason },
      }),
    );
  }

  private async one(
    authUser: AuthUser,
    organisationId: string,
    requestId: string,
  ): Promise<ForwardingRequestView> {
    const all = await this.list(authUser, organisationId);
    const found = all.find((request) => request.id === requestId);
    if (!found) throw new NotFoundException("No such forwarding request");
    return found;
  }

  /**
   * System context: the organisation is declared, but there is no acting user.
   * `set_config(..., true)` is SET LOCAL — scoped to the transaction, never
   * inherited by the next borrower of a pooled connection.
   */
  private async inTenant<T>(organisationId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.prisma.db.$transaction(async (rawTx) => {
      await rawTx.$executeRaw`SELECT set_config('app.current_org', ${organisationId}, true)`;
      return fn(rawTx as unknown as TenantTx);
    });
  }
}

/** Was the guided screen open recently enough for Eva to answer for them? */
export function isArmed(armedAt: Date | null, now: Date = new Date()): boolean {
  if (!armedAt) return false;
  return now.getTime() - armedAt.getTime() <= ARMED_WINDOW_MINUTES * 60_000;
}
