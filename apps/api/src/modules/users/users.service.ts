import { randomUUID } from "node:crypto";
import { ConflictException, Injectable } from "@nestjs/common";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PinoLogger } from "nestjs-pino";
import { withAuthIdentity, withUser } from "@eva/database";
import { SESSION_ACTIVITY_WRITE_INTERVAL_MS, isSessionIdle } from "@eva/types";
import { isUniqueViolationOn } from "../../common/errors/database-fault.js";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PrismaService } from "../../common/database/prisma.service.js";
import type { AuthUser } from "../authentication/current-auth-user.decorator.js";
import { SessionIdleTimeoutException } from "../authentication/session-idle-timeout.exception.js";

export interface AppUser {
  id: string;
  email: string;
  fullName: string | null;
  authUserId: string | null;
}

/** The stored row — `AppUser` plus the column only this service reads. */
type StoredUser = AppUser & { lastSeenAt: Date | null };

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
    if (existing) return this.admitReturningUser(existing);

    const id = randomUUID();
    const email = authUser.email.toLowerCase();
    try {
      return await withUser(this.prisma.db, id, (tx) =>
        tx.user.create({
          data: { id, email, authUserId: authUser.authUserId, lastSeenAt: new Date() },
        }),
      );
    } catch (error) {
      // Concurrent first login: the other request won the insert — re-read.
      const raced = await this.findByAuthUserId(authUser.authUserId);
      if (raced) return this.admitReturningUser(raced);
      if (isUniqueViolationOn(error, "email")) throw this.emailAlreadyClaimed(authUser);
      throw error;
    }
  }

  /**
   * The two-day idle sign-out (founder's request, 2026-08-12), enforced on the
   * read every data path already does.
   *
   * ⚠️ IT LIVES HERE AND NOT IN THE AUTH GUARD ON PURPOSE. The guard verifies
   * the JWT against a cached key and touches no database at all — putting the
   * check there would add a round trip to EVERY request, and our compute is in
   * Oregon while the database is in London (handoff §6). This method runs after
   * a read that had to happen anyway, so the rule costs nothing.
   *
   * ⚠️ SERVER-SIDE BECAUSE THAT IS THE WHOLE POINT. A timestamp the browser
   * carries travels with a stolen session and vouches for the thief. This one
   * is ours.
   */
  private async admitReturningUser(user: StoredUser): Promise<AppUser> {
    const now = new Date();
    if (isSessionIdle(user.lastSeenAt, now)) throw this.sessionIdledOut(user);
    if (this.shouldStampActivity(user.lastSeenAt, now)) await this.stampActivity(user.id, now);
    return user;
  }

  /** NULL stamps immediately — that is the first request after the column shipped. */
  private shouldStampActivity(lastSeenAt: Date | null, now: Date): boolean {
    if (!lastSeenAt) return true;
    return now.getTime() - lastSeenAt.getTime() > SESSION_ACTIVITY_WRITE_INTERVAL_MS;
  }

  /**
   * ⚠️ RAW, SO `updated_at` IS NOT DRAGGED ALONG. Prisma applies `@updatedAt` on
   * every `update()`, which would make "when did this record last change" mean
   * "when did this person last click something" — two different questions, and
   * the second one would overwrite the first every five minutes forever.
   *
   * The tenant policy on `users` allows a row to write itself
   * (`WITH CHECK (id = app.current_user)`), which is exactly this.
   */
  private async stampActivity(userId: string, now: Date): Promise<void> {
    await withUser(
      this.prisma.db,
      userId,
      (tx) => tx.$executeRaw`UPDATE users SET last_seen_at = ${now} WHERE id = ${userId}::uuid`,
    );
  }

  /**
   * ⚠️ THE CODE MATTERS MORE THAN THE MESSAGE. A bare 401 sends the web app to
   * `/sign-in`, where the Supabase cookie is still perfectly valid — so the
   * proxy sends them straight back to `/app`, which 401s again. The named code
   * is what lets the browser tell "your session went stale" apart from "your
   * token is rubbish" and actually END the session instead of looping.
   */
  private sessionIdledOut(user: StoredUser): SessionIdleTimeoutException {
    this.logger.info(
      { userId: user.id, lastSeenAt: user.lastSeenAt?.toISOString() ?? null },
      "session ended: idle longer than the two-day limit",
    );
    return new SessionIdleTimeoutException();
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

  private findByAuthUserId(authUserId: string): Promise<StoredUser | null> {
    return withAuthIdentity(this.prisma.db, authUserId, (tx) =>
      tx.user.findFirst({ where: { authUserId } }),
    );
  }
}
