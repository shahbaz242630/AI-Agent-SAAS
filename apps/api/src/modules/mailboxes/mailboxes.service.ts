import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
// Value import is intentional: NestJS DI reads design:paramtypes metadata,
// which requires the class reference at runtime (not a type-only import).
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PinoLogger } from "nestjs-pino";
import { withTenant } from "@eva/database";
import type { EmailAccountHealthStatus, MailboxConnectDto, MailboxStatusDto } from "@eva/types";
import type { MicrosoftCallbackQuery } from "@eva/validation";
import { API_ENV } from "../../config/config.module.js";
import type { ApiEnv } from "../../config/env.js";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PrismaService } from "../../common/database/prisma.service.js";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { UsersService } from "../users/users.service.js";
import { requirePermission } from "../../common/permissions/permissions.js";
import { writeAuditLog } from "../../common/audit/audit-log.js";
import { encryptToken } from "../../common/crypto/token-crypto.js";
import type { AuthUser } from "../authentication/current-auth-user.decorator.js";
import { MICROSOFT_GRAPH_PROVIDER } from "../integrations/microsoft-graph/microsoft-graph-provider.js";
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
    let tokens: OAuthTokens;
    let profile: MailboxProfile;
    try {
      tokens = await this.graph.exchangeCode(query.code);
      profile = await this.graph.getProfile(tokens.accessToken);
    } catch (error) {
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
      // The state stays valid for 10 minutes, so membership can be revoked
      // mid-flow; a DB outage lands here too. Logged with the cause (the
      // global filter would not) and redirected, because this route's
      // contract is "always a redirect".
      this.logger.error({ err: error }, "mailbox connection could not be persisted");
      return `${base}?error=connect_failed`;
    }
    this.logger.info({ emailAccountId: accountId }, "mailbox connected");
    return `${base}?connected=1`;
  }
}
