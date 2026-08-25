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

/** The stored row — `AppUser` plus the columns only this service reads. */
type StoredUser = AppUser & { lastSeenAt: Date | null; lastSessionId: string | null };

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
    if (existing) return this.admitReturningUser(existing, authUser.sessionId);

    const id = randomUUID();
    const email = authUser.email.toLowerCase();
    try {
      return await withUser(this.prisma.db, id, (tx) =>
        tx.user.create({
          data: {
            id,
            email,
            authUserId: authUser.authUserId,
            lastSeenAt: new Date(),
            lastSessionId: authUser.sessionId,
          },
        }),
      );
    } catch (error) {
      // Concurrent first login: the other request won the insert — re-read.
      const raced = await this.findByAuthUserId(authUser.authUserId);
      if (raced) return this.admitReturningUser(raced, authUser.sessionId);
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
   *
   * ⚠️ THE CLOCK BELONGS TO THE SESSION, NOT THE PERSON (ruling 37,
   * 2026-08-25), AND THE ORDER OF THESE TWO LINES IS THE WHOLE DEFECT IT
   * FIXES. The throw used to come first, ahead of the only line in the API that
   * writes `last_seen_at` — and that stamp is the only thing the check reads.
   * So a stale stamp could never be refreshed by anything, signing in included,
   * and every customer who spent two days away from Eva was locked out of their
   * account for good. It was live in production for thirteen days.
   *
   * ⚠️ A NEW SESSION ID IS THE KEY, AND NOTHING ELSE IS. Supabase opens a new
   * session row when somebody signs in and keeps the id across token refreshes,
   * so a different id means a real new sign-in — admit it and restart the
   * clock. A thief replaying the stolen session carries the SAME id and stays
   * refused, which is the property the rule exists for and the reason we do not
   * simply clear the stamp on the way out (considered and rejected 2026-08-25:
   * refused once, cleared, and the very next request succeeds).
   *
   * ⚠️ IT STILL CANNOT TELL A THIEF FROM A SECOND DEVICE. Two live sessions
   * take turns overwriting one column, so each looks new to the other and both
   * stay admitted. That is exactly as true of the per-user clock this replaces,
   * so nothing regresses — but closing it means a row per session, which is a
   * bigger change than a live lockout should wait for.
   */
  private async admitReturningUser(user: StoredUser, sessionId: string | null): Promise<AppUser> {
    const now = new Date();
    const isNewSession = sessionId !== null && sessionId !== user.lastSessionId;
    if (!isNewSession && isSessionIdle(user.lastSeenAt, now)) {
      throw this.sessionIdledOut(user, sessionId);
    }
    if (isNewSession || this.shouldStampActivity(user.lastSeenAt, now)) {
      await this.stampActivity(user.id, now, sessionId);
    }
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
   *
   * ⚠️ `COALESCE`, SO A TOKEN WITHOUT A SESSION ID CANNOT ERASE THE ONE WE
   * HAVE. Writing NULL over a real id would make the next ordinary request look
   * like a brand-new sign-in and hand it the one-time amnesty — turning a
   * missing claim into a way around the rule. Keeping the last id we actually
   * saw is both safer and more honest about what the column knows.
   */
  private async stampActivity(userId: string, now: Date, sessionId: string | null): Promise<void> {
    await withUser(
      this.prisma.db,
      userId,
      (tx) => tx.$executeRaw`UPDATE users
           SET last_seen_at = ${now},
               last_session_id = COALESCE(${sessionId}::text, last_session_id)
         WHERE id = ${userId}::uuid`,
    );
  }

  /**
   * ⚠️ THE CODE MATTERS MORE THAN THE MESSAGE. A bare 401 sends the web app to
   * `/sign-in`, where the Supabase cookie is still perfectly valid — so the
   * proxy sends them straight back to `/app`, which 401s again. The named code
   * is what lets the browser tell "your session went stale" apart from "your
   * token is rubbish" and actually END the session instead of looping.
   */
  private sessionIdledOut(user: StoredUser, sessionId: string | null): SessionIdleTimeoutException {
    this.logger.info(
      {
        userId: user.id,
        lastSeenAt: user.lastSeenAt?.toISOString() ?? null,
        /**
         * Which of the two ways in this was, because they mean very different
         * things. `true` is the case the rule is FOR: the session we last saw,
         * coming back after two days. `false` means the token carried no
         * `session_id` at all — which should be impossible, since Supabase
         * documents it as required, and would mean the claim has gone away and
         * every customer is about to be judged on the old per-user rule.
         *
         * ⚠️ NOT `user.lastSessionId !== null`, WHICH IS A DIFFERENT QUESTION.
         * That says what we have stored; this says what arrived.
         */
        replayedKnownSession: sessionId !== null,
      },
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
