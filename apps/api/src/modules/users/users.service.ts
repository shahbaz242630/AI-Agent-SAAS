import { randomUUID } from "node:crypto";
import { ConflictException, Injectable } from "@nestjs/common";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PinoLogger } from "nestjs-pino";
import { withAuthIdentity, withUser } from "@eva/database";
import { isUniqueViolationOn } from "../../common/errors/database-fault.js";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PrismaService } from "../../common/database/prisma.service.js";
import type { AuthUser } from "../authentication/current-auth-user.decorator.js";

export interface AppUser {
  id: string;
  email: string;
  fullName: string | null;
  authUserId: string | null;
}

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(UsersService.name);
  }

  /**
   * Resolves the app users row for a verified JWT identity, auto-provisioning
   * it on first login (Slice 0.3). Emails are lowercased before write (gap
   * G-004) — lookups match on auth_user_id, so casing can never split an
   * identity into two rows.
   */
  async resolveOrProvision(authUser: AuthUser): Promise<AppUser> {
    const existing = await this.findByAuthUserId(authUser.authUserId);
    if (existing) return existing;

    const id = randomUUID();
    const email = authUser.email.toLowerCase();
    try {
      return await withUser(this.prisma.db, id, (tx) =>
        tx.user.create({ data: { id, email, authUserId: authUser.authUserId } }),
      );
    } catch (error) {
      // Concurrent first login: the other request won the insert — re-read.
      const raced = await this.findByAuthUserId(authUser.authUserId);
      if (raced) return raced;
      if (isUniqueViolationOn(error, "email")) throw this.emailAlreadyClaimed(authUser);
      throw error;
    }
  }

  /**
   * The email is on a users row already, and that row answers to a DIFFERENT
   * sign-in identity.
   *
   * ⚠️ THIS COST THE FOUNDER A WORKING DASHBOARD FOR TWO HOURS ON 2026-08-11.
   * Their Supabase account was deleted and recreated in July→August; our row
   * still pointed at the dead identity, so every sign-in tried to provision a
   * second row, hit `users_email_key`, and fell out of here as a naked 500 —
   * on every page load, forever, with nothing in the log to say why.
   *
   * ⚠️ IT REFUSES. IT DOES NOT ADOPT THE ROW, AND THAT IS THE SECURITY
   * DECISION, not an unfinished edge case. Taking over a row because the email
   * matches is the "classic-federated merge" of the 2022 account-pre-hijacking
   * study (Microsoft MSRC / Sudhodanan & Paverd, arXiv 2205.10174) — 35 of 75
   * major services were vulnerable, and the root cause every time was acting on
   * an identifier before ownership of the ACCOUNT behind it was established.
   * Here the row can own an organisation, its customers and its whole invoice
   * book; "controls this mailbox today" must never be enough to inherit that.
   *
   * ⚠️ WHEN INVITES ARRIVE, DO NOT LOOSEN THIS. An invited person's claim must
   * be carried by the invite itself — a signed token naming the row — never by
   * a matching email address. A row with a null `auth_user_id` is not proof of
   * anything either: the demo fixtures have one.
   *
   * Told loudly because a refusal a customer cannot get past is an incident,
   * and 409s never reach the fault log.
   */
  private emailAlreadyClaimed(authUser: AuthUser): ConflictException {
    this.logger.error(
      {
        // The auth id, never the address: BRD 14 redacts `email` everywhere,
        // and the id is what finds the row.
        authUserId: authUser.authUserId,
        remedy: "re-point users.auth_user_id at this identity, or delete the stale row",
      },
      "sign-in blocked: email already claimed by another identity",
    );
    return new ConflictException(
      "This email address already belongs to an Eva account that your sign-in doesn't match. " +
        "Get in touch and we'll reconnect it — nothing is lost.",
    );
  }

  private findByAuthUserId(authUserId: string): Promise<AppUser | null> {
    return withAuthIdentity(this.prisma.db, authUserId, (tx) =>
      tx.user.findFirst({ where: { authUserId } }),
    );
  }
}
