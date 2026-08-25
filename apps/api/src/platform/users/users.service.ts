import { randomUUID } from "node:crypto";
import { ConflictException, Injectable } from "@nestjs/common";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PinoLogger } from "nestjs-pino";
import { withAuthIdentity, withUser, type EvaPrismaClient } from "@eva/database";
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

/**
 * The stored row — `AppUser` plus the column only this service reads.
 *
 * ⚠️ `lastSessionId` IS DELIBERATELY ABSENT. The column still exists (dropping
 * it needs its own migration, applied after a release that no longer reads it),
 * but one session id per USER is the very hole `user_sessions` was built to
 * close. Leaving it off this type is what stops it being read again by accident.
 */
type StoredUser = AppUser & { lastSeenAt: Date | null };

/**
 * ⚠️ THE RESPONSE IS THE DECLARED SHAPE AND NOTHING MORE. `GET /users/me`
 * returns whatever object this service hands back, and the row carries columns
 * the caller has no business seeing — when they were last active, and now when
 * this SESSION was last active, which is a detail of the security rule itself.
 * The old code returned the whole Prisma row and leaked those quietly; a
 * narrowing type alone would not have stopped it, because types are gone at
 * runtime. This is the line that actually strips them.
 */
const toAppUser = (user: StoredUser): AppUser => ({
  id: user.id,
  email: user.email,
  fullName: user.fullName,
  authUserId: user.authUserId,
});

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
    const existing = await this.findByAuthUserId(authUser.authUserId, authUser.sessionId);
    if (existing) return this.admitReturningUser(existing, authUser.sessionId);

    const id = randomUUID();
    const email = authUser.email.toLowerCase();
    const now = new Date();
    try {
      return await withUser(this.prisma.db, id, async (tx) => {
        const created = await tx.user.create({
          data: { id, email, authUserId: authUser.authUserId, lastSeenAt: now },
        });
        // First sign-in starts this session's clock in the same transaction, so
        // a user row can never exist without the session that made it.
        if (authUser.sessionId !== null) {
          await tx.userSession.create({
            data: { userId: id, sessionId: authUser.sessionId, lastSeenAt: now },
          });
        }
        return toAppUser(created);
      });
    } catch (error) {
      // Concurrent first login: the other request won the insert — re-read.
      const raced = await this.findByAuthUserId(authUser.authUserId, authUser.sessionId);
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
   * ⚠️ ONE STAMP PER PERSON COULD NOT TELL A THIEF FROM A SECOND DEVICE, WHICH
   * IS WHY THE STAMP NOW LIVES PER SESSION (`user_sessions`, migration 0033).
   * With a single column, two live sessions took turns overwriting it, so each
   * arrived looking different from what was stored — i.e. looking like a new
   * sign-in — and both were waved through forever. Measured on production
   * 2026-08-25: an auth session created five days earlier was still alive and
   * would have been admitted on sight. A busy laptop must never vouch for a
   * stolen phone.
   *
   * ⚠️ AN ABSENT ROW MEANS "NEVER SEEN", AND IS ADMITTED. That is what lets a
   * genuine returning customer in, and it is why nothing may ever prune this
   * table — deleting a row hands that session a fresh clock. See the migration's
   * ROLLBACK.md.
   */
  private async admitReturningUser(
    user: StoredUser & { sessionLastSeenAt: Date | null },
    sessionId: string | null,
  ): Promise<AppUser> {
    const now = new Date();

    /**
     * ⚠️ A TOKEN WITH NO `session_id` IS JUDGED ON THE OLDER, STRICTER RULE.
     * Supabase documents the claim as required, so this should be unreachable.
     * If it ever happens we cannot tell which session is asking — and the safe
     * reading of "I do not know" is the per-user stamp, not a free pass.
     */
    if (sessionId === null) {
      if (isSessionIdle(user.lastSeenAt, now)) {
        throw this.sessionIdledOut(user, null, user.lastSeenAt);
      }
      if (this.shouldStampActivity(user.lastSeenAt, now)) await this.stampUserOnly(user.id, now);
      return toAppUser(user);
    }

    // Already on the row — it travelled back with the user, on the query that
    // had to happen anyway. NULL means this session has never been seen.
    const seenAt = user.sessionLastSeenAt;
    if (seenAt !== null && isSessionIdle(seenAt, now)) {
      throw this.sessionIdledOut(user, sessionId, seenAt);
    }
    if (seenAt === null || this.shouldStampActivity(seenAt, now)) {
      await this.stampActivity(user.id, now, sessionId);
    }
    return toAppUser(user);
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
   * ⚠️ TWO WRITES, AND ONLY ONE OF THEM IS THE RULE. The `user_sessions` row is
   * what the idle check reads. `users.last_seen_at` is kept as "last seen
   * anywhere" for support questions — **do not rebuild the security rule on it**,
   * because one timestamp per person is the hole migration 0033 closed.
   */
  private async stampActivity(userId: string, now: Date, sessionId: string): Promise<void> {
    await withUser(this.prisma.db, userId, async (tx) => {
      await tx.userSession.upsert({
        where: { userId_sessionId: { userId, sessionId } },
        create: { userId, sessionId, lastSeenAt: now },
        update: { lastSeenAt: now },
      });
      await this.writeUserStamp(tx, userId, now);
    });
  }

  /** The fallback path: no session to stamp, so only the person's own row. */
  private async stampUserOnly(userId: string, now: Date): Promise<void> {
    await withUser(this.prisma.db, userId, (tx) => this.writeUserStamp(tx, userId, now));
  }

  private writeUserStamp(tx: EvaPrismaClient, userId: string, now: Date): Promise<number> {
    return tx.$executeRaw`UPDATE users SET last_seen_at = ${now} WHERE id = ${userId}::uuid`;
  }

  /**
   * ⚠️ THE CODE MATTERS MORE THAN THE MESSAGE. A bare 401 sends the web app to
   * `/sign-in`, where the Supabase cookie is still perfectly valid — so the
   * proxy sends them straight back to `/app`, which 401s again. The named code
   * is what lets the browser tell "your session went stale" apart from "your
   * token is rubbish" and actually END the session instead of looping.
   */
  private sessionIdledOut(
    user: StoredUser,
    sessionId: string | null,
    idleSince: Date | null,
  ): SessionIdleTimeoutException {
    this.logger.info(
      {
        userId: user.id,
        // The stamp actually judged: this SESSION's, or the person's on the
        // fallback path. Not the same question as `users.last_seen_at`, which
        // says when they were last active anywhere.
        idleSince: idleSince?.toISOString() ?? null,
        /**
         * Which of the two ways in this was, because they mean very different
         * things. `true` is the case the rule is FOR: a known session coming
         * back after two days. `false` means the token carried no `session_id`
         * at all — which should be impossible, since Supabase documents it as
         * required, and would mean the claim has gone away and everybody is
         * being judged on the older per-user stamp.
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

  /**
   * The one read every authenticated request already made — now carrying this
   * session's activity stamp back with it.
   *
   * ⚠️ IT IS ONE QUERY BECAUSE THE SECOND ONE WAS EXPENSIVE OUT OF ALL
   * PROPORTION TO ITS WORK. The stamp lookup itself costs 0.024ms and stays
   * there at 50,000 rows — but reading it separately means its own transaction,
   * since RLS context is set with `SET LOCAL` and only a transaction can carry
   * it safely across a pooled connection. That is BEGIN, set_config, SELECT,
   * COMMIT: four round trips, on every authenticated request. Measured on
   * production 2026-08-25 — a request that touches no database answers in 3ms
   * and one that does takes 140-330ms, so round trips, not queries, are what
   * this system spends its time on. Joined here, the stamp is free.
   *
   * ⚠️ RAW SQL ON PURPOSE. `include` would let Prisma decide whether to join or
   * to issue a second query, and the entire point of this shape is that it is
   * exactly ONE. Left join, so "no row" comes back as NULL and stays
   * distinguishable from "row with an old stamp" — those mean opposite things
   * to the idle rule.
   *
   * ⚠️ NO `deleted_at` FILTER, MATCHING WHAT THIS REPLACED. `findFirst` applied
   * none, and quietly adding one here would change who can sign in.
   */
  private async findByAuthUserId(
    authUserId: string,
    sessionId: string | null,
  ): Promise<(StoredUser & { sessionLastSeenAt: Date | null }) | null> {
    const rows = await withAuthIdentity(
      this.prisma.db,
      authUserId,
      (tx) => tx.$queryRaw<
        {
          id: string;
          email: string;
          full_name: string | null;
          auth_user_id: string | null;
          last_seen_at: Date | null;
          session_last_seen_at: Date | null;
        }[]
      >`
        SELECT u.id, u.email, u.full_name, u.auth_user_id, u.last_seen_at,
               s.last_seen_at AS session_last_seen_at
          FROM users u
          LEFT JOIN user_sessions s
            ON s.user_id = u.id AND s.session_id = ${sessionId}
         WHERE u.auth_user_id = ${authUserId}::uuid
         LIMIT 1`,
    );

    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      email: row.email,
      fullName: row.full_name,
      authUserId: row.auth_user_id,
      lastSeenAt: row.last_seen_at,
      sessionLastSeenAt: row.session_last_seen_at,
    };
  }
}
