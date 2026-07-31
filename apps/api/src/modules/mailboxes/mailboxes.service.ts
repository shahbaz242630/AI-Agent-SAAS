import { randomUUID } from "node:crypto";
import {
  BadGatewayException,
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
// Value import is intentional: NestJS DI reads design:paramtypes metadata,
// which requires the class reference at runtime (not a type-only import).
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PinoLogger } from "nestjs-pino";
import { withTenant } from "@eva/database";
import type {
  EmailAccountHealthStatus,
  MailboxConnectDto,
  MailboxStatusDto,
  MailboxTestEmailResultDto,
} from "@eva/types";
import type { MicrosoftCallbackQuery } from "@eva/validation";
import { API_ENV } from "../../config/config.module.js";
import type { ApiEnv } from "../../config/env.js";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PrismaService } from "../../common/database/prisma.service.js";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { UsersService } from "../users/users.service.js";
import { requirePermission, type TenantTx } from "../../common/permissions/permissions.js";
import { writeAuditLog } from "../../common/audit/audit-log.js";
import {
  decryptToken,
  encryptToken,
  TokenDecryptionError,
} from "../../common/crypto/token-crypto.js";
import type { AuthUser } from "../authentication/current-auth-user.decorator.js";
import {
  GraphRequestError,
  MailboxUnavailableError,
  MICROSOFT_GRAPH_PROVIDER,
  ReauthRequiredError,
} from "../integrations/microsoft-graph/microsoft-graph-provider.js";
import type {
  MailboxProfile,
  MicrosoftGraphProvider,
  OAuthTokens,
} from "../integrations/microsoft-graph/microsoft-graph-provider.js";
import { signOAuthState, verifyOAuthState, type OAuthStateClaims } from "./oauth-state.js";

/**
 * Microsoft reports "your admin must approve this app" as a plain
 * error=access_denied — indistinguishable from a user clicking Cancel except
 * for the AADSTS code in error_description. It is the DEFAULT outcome for an
 * unverified publisher requesting Mail scopes, so most real customers meet
 * it, and most are not their own admin (founder ruling 2026-07-30): they get
 * a distinct, actionable message rather than "you cancelled".
 */
const ADMIN_CONSENT_CODES = /AADSTS90094|AADSTS90095/;

/** Buffer before token_expires_at within which refresh-on-use kicks in (ruling 10). */
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;

const AUTH_EXPIRED_MESSAGE = "Microsoft authorisation expired — reconnect the mailbox";

/** The live email_accounts row as findFirst returns it (inferred — avoids
 *  wrestling Prisma's GetPayload generics under exactOptionalPropertyTypes). */
type ConnectedAccount = NonNullable<Awaited<ReturnType<TenantTx["emailAccount"]["findFirst"]>>>;

/** GET .../mailbox payload when nothing is connected (plan §3). */
const EMPTY_STATUS: MailboxStatusDto = {
  connected: false,
  provider: null,
  emailAddress: null,
  displayName: null,
  healthStatus: null,
  lastHealthCheckAt: null,
  lastError: null,
  connectedBy: null,
  connectedAt: null,
};

@Injectable()
export class MailboxesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly usersService: UsersService,
    private readonly logger: PinoLogger,
    @Inject(API_ENV) private readonly env: ApiEnv,
    @Inject(MICROSOFT_GRAPH_PROVIDER) private readonly graph: MicrosoftGraphProvider,
  ) {
    this.logger.setContext(MailboxesService.name);
  }

  /** GET .../mailbox — mailbox:read. Sanitized status; tokens NEVER leave
   *  the database (plan §8 risk 1). Reads are not audited. */
  async getMailboxStatus(authUser: AuthUser, organisationId: string): Promise<MailboxStatusDto> {
    const user = await this.usersService.resolveOrProvision(authUser);
    return withTenant(this.prisma.db, { organisationId, userId: user.id }, async (tx) => {
      await requirePermission(tx, organisationId, user.id, "mailbox:read");
      const account = await tx.emailAccount.findFirst({ where: { deletedAt: null } });
      if (!account) return EMPTY_STATUS;
      return {
        connected: true,
        provider: "microsoft",
        emailAddress: account.emailAddress,
        displayName: account.displayName,
        healthStatus: account.healthStatus as EmailAccountHealthStatus,
        lastHealthCheckAt: account.lastHealthCheckAt?.toISOString() ?? null,
        lastError: account.lastError,
        connectedBy: account.connectedBy,
        connectedAt: account.createdAt.toISOString(),
      };
    });
  }

  /** POST .../mailbox/connect — mailbox:manage. Mints the 10-minute state
   *  JWT (ruling 4) and returns the Microsoft authorize URL; the web app
   *  redirects the browser there. */
  async connect(authUser: AuthUser, organisationId: string): Promise<MailboxConnectDto> {
    const user = await this.usersService.resolveOrProvision(authUser);
    await withTenant(this.prisma.db, { organisationId, userId: user.id }, async (tx) => {
      await requirePermission(tx, organisationId, user.id, "mailbox:manage");
    });
    const state = await signOAuthState(this.env.OAUTH_STATE_SECRET, {
      organisationId,
      userId: user.id,
      nonce: randomUUID(),
    });
    return { authorizeUrl: this.graph.buildAuthorizeUrl(state) };
  }

  /**
   * GET /integrations/microsoft/callback (@Public, ruling 4). ALWAYS returns
   * the web redirect URL — ?connected=1 on success, else ?error=<code> — so a
   * browser arriving from Microsoft never sees a raw JSON error. Network calls
   * (exchange, profile) run BEFORE the tenant transaction so a slow Microsoft
   * never holds a DB connection; the upsert + audit commit together.
   * Codes/state are never logged (BRD 14).
   */
  async handleCallback(query: MicrosoftCallbackQuery): Promise<string> {
    const base = `${this.env.WEB_ORIGIN}/app/settings/mailbox`;
    if (query.error) {
      if (ADMIN_CONSENT_CODES.test(query.error_description ?? "")) {
        this.logger.info("mailbox connection needs Microsoft 365 admin approval");
        return `${base}?error=admin_consent_required`;
      }
      this.logger.info("mailbox connection declined at Microsoft");
      return `${base}?error=consent_denied`;
    }
    let claims: OAuthStateClaims;
    try {
      claims = await verifyOAuthState(this.env.OAUTH_STATE_SECRET, query.state);
    } catch {
      return `${base}?error=invalid_state`;
    }
    if (!query.code) return `${base}?error=missing_code`;
    // Re-check authorisation at the moment of the mutation. The state stays
    // valid for 10 minutes and ruling 4 binds it to an ORGANISATION, not to a
    // role — so the initiator can be removed from the org or demoted out of
    // mailbox:manage in between. Nothing downstream would catch that: RLS only
    // checks organisation_id, so the write would succeed and the audit row
    // would credit a user who is no longer allowed to connect. Checked before
    // the exchange so an unauthorised attempt never spends the code.
    try {
      await withTenant(
        this.prisma.db,
        { organisationId: claims.organisationId, userId: claims.userId },
        async (tx) => {
          await requirePermission(tx, claims.organisationId, claims.userId, "mailbox:manage");
        },
      );
    } catch (error) {
      if (error instanceof ForbiddenException || error instanceof NotFoundException) {
        this.logger.info("mailbox callback rejected — initiator no longer authorised");
        return `${base}?error=not_authorised`;
      }
      this.logger.error({ err: error }, "mailbox callback authorisation check failed");
      return `${base}?error=connect_failed`;
    }
    let tokens: OAuthTokens;
    let profile: MailboxProfile;
    try {
      tokens = await this.graph.exchangeCode(query.code);
      profile = await this.graph.getProfile(tokens.accessToken);
      // Defect F3: an account with no Exchange licence consents perfectly
      // happily and only fails at the first send — where it surfaced as
      // "authorisation expired", advice that can never work, so the user
      // looped forever. Prove there is a mailbox BEFORE storing anything:
      // a dead connection stored here is one 1.7 would try to send through.
      await this.graph.probeMailbox(tokens.accessToken);
    } catch (error) {
      if (error instanceof MailboxUnavailableError) {
        this.logger.info("mailbox connection rejected — account has no mailbox");
        return `${base}?error=mailbox_unavailable`;
      }
      this.logger.warn({ err: error }, "mailbox token exchange/profile failed");
      return `${base}?error=exchange_failed`;
    }
    const key = this.env.TOKEN_ENCRYPTION_KEY;
    const data = {
      provider: "microsoft",
      emailAddress: profile.emailAddress,
      displayName: profile.displayName,
      accessTokenEncrypted: encryptToken(tokens.accessToken, key),
      refreshTokenEncrypted: encryptToken(tokens.refreshToken, key),
      tokenExpiresAt: new Date(Date.now() + tokens.expiresInSeconds * 1000),
      scopes: tokens.scopes,
      healthStatus: "active",
      lastError: null,
      // Reconnect reuses the row, so clear the previous connection's health
      // stamp — otherwise a fresh mailbox shows a check time from before the
      // outage that caused the reconnect.
      lastHealthCheckAt: null,
      connectedBy: claims.userId,
    };
    let accountId: string;
    try {
      accountId = await withTenant(
        this.prisma.db,
        { organisationId: claims.organisationId, userId: claims.userId },
        async (tx) => {
          // One live connection per org (ruling 6): replace in place.
          const existing = await tx.emailAccount.findFirst({ where: { deletedAt: null } });
          const account = existing
            ? await tx.emailAccount.update({ where: { id: existing.id }, data })
            : await tx.emailAccount.create({
                data: { ...data, organisationId: claims.organisationId, createdBy: claims.userId },
              });
          await writeAuditLog(tx, {
            organisationId: claims.organisationId,
            actorUserId: claims.userId,
            action: "mailbox.connected",
            entityType: "email_account",
            entityId: account.id,
            metadata: { emailAddress: profile.emailAddress, provider: "microsoft" },
          });
          return account.id;
        },
      );
    } catch (error) {
      // A DB outage, or the org being deleted between consent and write.
      // (Revoked membership is caught by the authorisation re-check above, not
      // here — RLS alone would let that write through.) Logged with the cause,
      // which the global filter would not do, then redirected, because this
      // route's contract is "always a redirect".
      this.logger.error({ err: error }, "mailbox connection could not be persisted");
      return `${base}?error=connect_failed`;
    }
    this.logger.info({ emailAccountId: accountId }, "mailbox connected");
    return `${base}?connected=1`;
  }

  /** POST .../mailbox/disconnect — mailbox:manage. Tokens hard-gone
   *  (columns nulled) + soft delete in ONE transaction (ruling 8); the row
   *  stays as audit history and does not block reconnect (partial index). */
  async disconnect(authUser: AuthUser, organisationId: string): Promise<void> {
    const user = await this.usersService.resolveOrProvision(authUser);
    await withTenant(this.prisma.db, { organisationId, userId: user.id }, async (tx) => {
      await requirePermission(tx, organisationId, user.id, "mailbox:manage");
      const account = await tx.emailAccount.findFirst({ where: { deletedAt: null } });
      if (!account) throw new NotFoundException("No connected mailbox");
      await tx.emailAccount.update({
        where: { id: account.id },
        data: {
          accessTokenEncrypted: null,
          refreshTokenEncrypted: null,
          tokenExpiresAt: null,
          deletedAt: new Date(),
        },
      });
      await writeAuditLog(tx, {
        organisationId,
        actorUserId: user.id,
        action: "mailbox.disconnected",
        entityType: "email_account",
        entityId: account.id,
      });
    });
    this.logger.info({ organisationId }, "mailbox disconnected");
  }

  /**
   * POST .../mailbox/test-email — mailbox:manage. Self-addressed send
   * (ruling 7) proving the full path: valid token → Graph → Sent Items.
   *
   * FOUR independently committed steps, deliberately NOT one transaction
   * (founder ruling 2026-07-30). Sending mail and rotating tokens are both
   * irreversible: a single transaction that failed at COMMIT would leave
   * Microsoft's state ahead of ours — mail sent with nothing recorded. That is
   * not hypothetical, 1.5's PR #36 fixed a transaction timing out at
   * transatlantic latency after its work had succeeded. No network call runs
   * inside a transaction here, which is also why the 30s timeout that guarded
   * the old shape is gone.
   *
   * 1.7 MUST follow this shape per reminder: claim in a committed transaction
   * BEFORE sending, then record the outcome after. Steps 3→4 stay
   * non-atomic — irreducible for any external send — so a crash between them
   * leaves a claimed row that must never be auto-retried.
   */
  async sendTestEmail(
    authUser: AuthUser,
    organisationId: string,
  ): Promise<MailboxTestEmailResultDto> {
    const user = await this.usersService.resolveOrProvision(authUser);
    // 1. Authorize + load. Read-only, so nothing to lose on rollback.
    const account = await withTenant(
      this.prisma.db,
      { organisationId, userId: user.id },
      async (tx) => {
        await requirePermission(tx, organisationId, user.id, "mailbox:manage");
        const found = await tx.emailAccount.findFirst({ where: { deletedAt: null } });
        if (!found) throw new NotFoundException("No connected mailbox");
        return found;
      },
    );
    try {
      // 2. Token. Any rotation is committed before we send (see below).
      const accessToken = await this.ensureAccessToken(organisationId, user.id, account);
      // 3. Send. No transaction open.
      await this.graph.sendMail(accessToken, {
        to: account.emailAddress,
        subject: "Eva test email",
        bodyText:
          "This is a test email from Eva, sent to confirm your Outlook mailbox is connected correctly. You can ignore it.",
      });
    } catch (error) {
      // The licence was removed after connecting (connect itself now probes,
      // F3). Not auth_expired — reconnecting cannot conjure a mailbox — so it
      // gets health 'error' and its own advice.
      if (error instanceof MailboxUnavailableError) {
        await this.markUnhealthy(organisationId, user.id, {
          healthStatus: "error",
          lastError: error.message,
          auditAction: "mailbox.mailbox_unavailable",
        });
        throw new BadRequestException(error.message);
      }
      if (error instanceof ReauthRequiredError) {
        await this.markUnhealthy(organisationId, user.id, {
          healthStatus: "auth_expired",
          lastError: AUTH_EXPIRED_MESSAGE,
          auditAction: "mailbox.auth_expired",
        });
        throw new BadRequestException(AUTH_EXPIRED_MESSAGE);
      }
      if (error instanceof GraphRequestError) {
        throw new BadGatewayException(
          "Microsoft Graph could not send the test email — try again shortly",
        );
      }
      throw error;
    }
    // 4. Record the outcome.
    await withTenant(this.prisma.db, { organisationId, userId: user.id }, async (tx) => {
      await tx.emailAccount.update({
        where: { id: account.id },
        data: { healthStatus: "active", lastHealthCheckAt: new Date(), lastError: null },
      });
      await writeAuditLog(tx, {
        organisationId,
        actorUserId: user.id,
        action: "mailbox.test_email_sent",
        entityType: "email_account",
        entityId: account.id,
      });
    });
    return { sent: true, to: account.emailAddress };
  }

  /**
   * Refresh-on-use (ruling 10) — THE seam 1.7's sender calls before every
   * send. Returns a usable access token, refreshing first when inside the
   * 5-minute expiry buffer, and throwing ReauthRequiredError when Microsoft
   * has revoked the grant.
   *
   * The rotated pair is persisted in its OWN transaction and COMMITTED before
   * this returns. Microsoft has already moved on by then, so the new pair must
   * not be able to roll back with whatever the caller does next. Callers
   * therefore call this BEFORE opening their own transaction — never inside
   * one. A still-valid token opens no transaction at all.
   */
  async ensureAccessToken(
    organisationId: string,
    userId: string,
    account: ConnectedAccount,
  ): Promise<string> {
    if (account.organisationId !== organisationId) {
      // Programmer error, not a tenancy hole (RLS would filter the row out and
      // surface an opaque Prisma error instead). Fail loudly for 1.7's callers.
      throw new Error("ensureAccessToken: account belongs to a different organisation");
    }
    const key = this.env.TOKEN_ENCRYPTION_KEY;
    if (
      !account.accessTokenEncrypted ||
      !account.refreshTokenEncrypted ||
      !account.tokenExpiresAt
    ) {
      throw new ReauthRequiredError();
    }
    if (account.tokenExpiresAt.getTime() - Date.now() > TOKEN_EXPIRY_BUFFER_MS) {
      return this.decryptStoredToken(account.accessTokenEncrypted, key);
    }
    const tokens = await this.graph.refreshTokens(
      this.decryptStoredToken(account.refreshTokenEncrypted, key),
    );
    await withTenant(this.prisma.db, { organisationId, userId }, async (tx) => {
      await tx.emailAccount.update({
        where: { id: account.id },
        data: {
          accessTokenEncrypted: encryptToken(tokens.accessToken, key),
          refreshTokenEncrypted: encryptToken(tokens.refreshToken, key),
          tokenExpiresAt: new Date(Date.now() + tokens.expiresInSeconds * 1000),
          scopes: tokens.scopes,
        },
      });
    });
    return tokens.accessToken;
  }

  /**
   * Stored ciphertext that will not decrypt (TOKEN_ENCRYPTION_KEY rotated, row
   * corrupted) is a dead grant from the user's point of view: the only fix is
   * reconnecting. Mapping it to ReauthRequiredError makes health_status say so,
   * instead of an opaque 500 beside a card still reading "Connected" — which
   * would strand 1.7's sender permanently with no health signal.
   */
  private decryptStoredToken(ciphertext: string, key: string): string {
    try {
      return decryptToken(ciphertext, key);
    } catch (error) {
      if (error instanceof TokenDecryptionError) {
        this.logger.error("stored mailbox token could not be decrypted — reconnect required");
        throw new ReauthRequiredError();
      }
      throw error;
    }
  }

  /** Surfaces a broken mailbox to the UI (ruling 10): the status endpoint reads
   *  health_status, so the right advice shows without another Graph call.
   *  Audited in the same transaction like every other tenant mutation — "when
   *  did this mailbox die, and why?" must be answerable from the audit trail,
   *  not from a mutable column with no timestamp. */
  private async markUnhealthy(
    organisationId: string,
    userId: string,
    outcome: { healthStatus: EmailAccountHealthStatus; lastError: string; auditAction: string },
  ): Promise<void> {
    await withTenant(this.prisma.db, { organisationId, userId }, async (tx) => {
      const account = await tx.emailAccount.findFirst({ where: { deletedAt: null } });
      if (!account) return;
      await tx.emailAccount.update({
        where: { id: account.id },
        data: {
          healthStatus: outcome.healthStatus,
          lastError: outcome.lastError,
          // A failed attempt is still an attempt (the DTO documents this field
          // as "null until a test email / send attempt runs").
          lastHealthCheckAt: new Date(),
        },
      });
      await writeAuditLog(tx, {
        organisationId,
        actorUserId: userId,
        action: outcome.auditAction,
        entityType: "email_account",
        entityId: account.id,
      });
    });
  }
}
