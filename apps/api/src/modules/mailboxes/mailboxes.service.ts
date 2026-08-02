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
  MailboxAdminConsentDto,
  MailboxConnectDto,
  MailboxDto,
  MailboxListDto,
  MailboxTestEmailResultDto,
} from "@eva/types";
import type { MailboxConnectInput, MicrosoftCallbackQuery } from "@eva/validation";
import { API_ENV } from "../../config/config.module.js";
import type { ApiEnv } from "../../config/env.js";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PrismaService } from "../../common/database/prisma.service.js";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { UsersService } from "../users/users.service.js";
import { requirePermission, type TenantTx } from "../../common/permissions/permissions.js";
import { ModuleNotEntitledException } from "../../common/permissions/module-not-entitled.exception.js";
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
import {
  MICROSOFT_DISCOVERY,
  UNKNOWN_DOMAIN,
} from "../integrations/microsoft-graph/microsoft-discovery.js";
import type { MicrosoftDiscovery } from "../integrations/microsoft-graph/microsoft-discovery.js";
import {
  DEFAULT_OAUTH_FLOW,
  signOAuthState,
  verifyOAuthState,
  type OAuthFlow,
  type OAuthStateClaims,
} from "./oauth-state.js";

/**
 * Microsoft reports "your admin must approve this app" as a plain
 * error=access_denied â€” indistinguishable from a user clicking Cancel except
 * for the AADSTS code in error_description. It is the DEFAULT outcome for an
 * unverified publisher requesting Mail scopes, so most real customers meet
 * it, and most are not their own admin (founder ruling 2026-07-30): they get
 * a distinct, actionable message rather than "you cancelled".
 */
const ADMIN_CONSENT_CODES = /AADSTS90094|AADSTS90095/;

/** Buffer before token_expires_at within which refresh-on-use kicks in (ruling 10). */
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;

const AUTH_EXPIRED_MESSAGE = "Microsoft authorisation expired â€” reconnect the mailbox";

/**
 * Where the callback sends the browser, per flow.
 *
 * A FIXED table, keyed by an enum carried on the signed state â€” the caller
 * never supplies a path or a URL. Signing a destination would not make it safe:
 * this redirect happens after we are back on our own origin, so Microsoft's
 * `redirect_uri` allowlist has already done its work and would not catch a
 * second hop somewhere else.
 */
const FLOW_RETURN_PATHS: Record<OAuthFlow, string> = {
  onboarding: "/app/onboarding",
  settings: "/app/settings/mailbox",
};

/**
 * Where the `/adminconsent` return goes â€” deliberately NOT one of the paths
 * above, and deliberately not behind sign-in.
 *
 * The approver is the customer's IT contact following a forwarded link. They
 * have no Eva account, so every `/app/...` destination bounced them to
 * `/sign-in` with the query string stripped, discarding the confirmation
 * entirely. The person whose goodwill the whole journey depends on saw a login
 * form and no sign that their approval had worked.
 */
const ADMIN_CONSENT_RETURN_PATH = "/microsoft-approved";

/** The self-addressed test send (ruling 7). One definition, because the manual
 *  button and the automatic send on first connect must prove the same thing. */
const TEST_EMAIL = {
  subject: "Eva test email",
  bodyText:
    "This is a test email from Eva, sent to confirm your Outlook mailbox is connected correctly. You can ignore it.",
};

/** The live email_accounts row as findFirst returns it (inferred â€” avoids
 *  wrestling Prisma's GetPayload generics under exactOptionalPropertyTypes). */
type ConnectedAccount = NonNullable<Awaited<ReturnType<TenantTx["emailAccount"]["findFirst"]>>>;

/** The product whose seats a mailbox occupies (slice 1.6a). */
const MAILBOX_MODULE = "email_credit_controller";

/** Internal signal from inside the callback's write transaction. Not an
 *  HttpException: this route's contract is ALWAYS a redirect, never JSON. */
class SeatLimitReachedError extends Error {
  constructor() {
    super("seat limit reached");
    this.name = "SeatLimitReachedError";
  }
}

/** Seats an organisation gets when no module row can be read. One, not
 *  unlimited: this is the fail-closed direction, and it matches the migration
 *  backfill so it can never look like a downgrade. */
const DEFAULT_SEATS = 1;

function toMailboxDto(account: ConnectedAccount, allocatedClientCount = 0): MailboxDto {
  return {
    id: account.id,
    provider: "microsoft",
    emailAddress: account.emailAddress,
    displayName: account.displayName,
    healthStatus: account.healthStatus as EmailAccountHealthStatus,
    isPrimary: account.isPrimary,
    allocatedClientCount,
    lastHealthCheckAt: account.lastHealthCheckAt?.toISOString() ?? null,
    lastError: account.lastError,
    connectedBy: account.connectedBy,
    connectedAt: account.createdAt.toISOString(),
  };
}

@Injectable()
export class MailboxesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly usersService: UsersService,
    private readonly logger: PinoLogger,
    @Inject(API_ENV) private readonly env: ApiEnv,
    @Inject(MICROSOFT_GRAPH_PROVIDER) private readonly graph: MicrosoftGraphProvider,
    @Inject(MICROSOFT_DISCOVERY) private readonly discovery: MicrosoftDiscovery,
  ) {
    this.logger.setContext(MailboxesService.name);
  }

  /** GET .../mailboxes â€” mailbox:read. Sanitized; tokens NEVER leave the
   *  database (plan Â§8 risk 1). Reads are not audited. */
  async listMailboxes(authUser: AuthUser, organisationId: string): Promise<MailboxListDto> {
    const user = await this.usersService.resolveOrProvision(authUser);
    return withTenant(this.prisma.db, { organisationId, userId: user.id }, async (tx) => {
      await requirePermission(tx, organisationId, user.id, "mailbox:read");
      const accounts = await tx.emailAccount.findMany({
        where: { deletedAt: null },
        // Primary first, then oldest — a stable order so the list does not
        // reshuffle under the customer between renders.
        orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
      });
      const seats = await this.seatsFor(tx);
      /**
       * How many clients each mailbox actually chases (slice 1.6b). ONE grouped
       * query rather than one per mailbox — this runs on every settings render,
       * and the 1.5 PR #36 lesson is that round trips are what hurt at
       * US↔London latency.
       *
       * Unallocated clients are deliberately absent: they fall back to the
       * default at SEND time (ruling 1) and counting them here would freeze
       * today's default into a number the customer reads as a filing.
       */
      const counts = await tx.customer.groupBy({
        by: ["emailAccountId"],
        where: { deletedAt: null, emailAccountId: { not: null } },
        _count: { _all: true },
      });
      const countByMailbox = new Map(
        counts.map((row) => [row.emailAccountId, row._count._all] as const),
      );
      return {
        mailboxes: accounts.map((account) =>
          toMailboxDto(account, countByMailbox.get(account.id) ?? 0),
        ),
        seats,
        seatLimitReached: accounts.length >= seats,
      };
    });
  }

  /** Seats bought for the mailbox-bearing product. Fails CLOSED: a missing or
   *  disabled module row reads as the default rather than as unlimited. */
  private async seatsFor(tx: TenantTx): Promise<number> {
    const module = await tx.organisationModule.findFirst({
      where: { moduleKey: MAILBOX_MODULE, deletedAt: null },
    });
    return module?.seats ?? DEFAULT_SEATS;
  }

  /** POST .../mailboxes/connect â€” mailbox:manage. Mints the 30-minute state
   *  JWT (ruling 4) and returns the Microsoft authorize URL; the web app
   *  redirects the browser there. The optional address becomes Microsoft's
   *  `login_hint` (F5) and is carried on the state so a declined callback can
   *  still say which account was attempted â€” Microsoft tells us nothing. */
  async connect(
    authUser: AuthUser,
    organisationId: string,
    input: MailboxConnectInput = {},
  ): Promise<MailboxConnectDto> {
    const user = await this.usersService.resolveOrProvision(authUser);
    await withTenant(this.prisma.db, { organisationId, userId: user.id }, async (tx) => {
      await requirePermission(tx, organisationId, user.id, "mailbox:manage");
      /**
       * A FRIENDLY pre-check, not the authoritative one — that lives in the
       * callback, inside the write transaction, because this reads and the
       * write happens a Microsoft round trip later.
       *
       * It exists so nobody is sent off to grant Eva access to their mail and
       * then told it was pointless. Reconnecting an address that already has a
       * row is always allowed: it reuses that row and consumes no new seat,
       * and refusing it would strand a customer whose only mailbox has an
       * expired grant at exactly the moment they are trying to fix it.
       */
      const seats = await this.seatsFor(tx);
      const live = await tx.emailAccount.findMany({
        where: { deletedAt: null },
        select: { emailAddress: true },
      });
      const reconnecting =
        input.emailAddress !== undefined &&
        live.some(
          (account) =>
            account.emailAddress.toLowerCase() === input.emailAddress!.trim().toLowerCase(),
        );
      if (!reconnecting && live.length >= seats) {
        throw new BadRequestException(
          `All ${seats} mailbox ${seats === 1 ? "seat is" : "seats are"} in use. Disconnect one, or add a seat, before connecting another.`,
        );
      }
    });
    const state = await signOAuthState(this.env.OAUTH_STATE_SECRET, {
      organisationId,
      userId: user.id,
      nonce: randomUUID(),
      ...(input.emailAddress ? { loginHint: input.emailAddress } : {}),
      // Rides on the state because Microsoft returns `state` untouched and
      // nothing else survives the round trip â€” the browser is at Microsoft in
      // between, so we cannot hold this in a cookie we control.
      ...(input.flow ? { flow: input.flow } : {}),
    });
    return {
      authorizeUrl: this.graph.buildAuthorizeUrl(state, {
        ...(input.emailAddress ? { loginHint: input.emailAddress } : {}),
      }),
    };
  }

  /**
   * GET .../mailboxes/admin-consent â€” mailbox:manage. The administrator half of
   * the declined-consent screen (defect F1).
   *
   * The state carried into the approval link lives for SEVEN DAYS, not ten
   * minutes, because this journey is asynchronous by design: the customer
   * forwards the link to whoever runs their IT, who opens it whenever they get
   * to it. It is purpose-scoped so it cannot be used to complete a connect.
   */
  async getAdminConsent(
    authUser: AuthUser,
    organisationId: string,
    emailAddress?: string,
  ): Promise<MailboxAdminConsentDto> {
    const user = await this.usersService.resolveOrProvision(authUser);
    await withTenant(this.prisma.db, { organisationId, userId: user.id }, async (tx) => {
      await requirePermission(tx, organisationId, user.id, "mailbox:manage");
    });
    const domain = emailAddress?.split("@")[1] ?? "";
    const discovery = domain ? await this.discovery.describeDomain(domain) : UNKNOWN_DOMAIN;
    // No administrator exists for a personal Microsoft account. Offering a
    // consent link would send a sole trader hunting for an IT department.
    if (discovery.kind === "personal") {
      return { accountKind: "personal", url: null, organisationName: null };
    }
    const state = await signOAuthState(this.env.OAUTH_STATE_SECRET, {
      organisationId,
      userId: user.id,
      nonce: randomUUID(),
      purpose: "admin_consent",
    });
    const params = new URLSearchParams({
      client_id: this.env.MICROSOFT_CLIENT_ID,
      redirect_uri: this.env.MICROSOFT_OAUTH_REDIRECT_URI,
      state,
    });
    // Tenant-specific where known: 1.6's evidence showed it renders the correct
    // org-wide screen ("No one else will be prompted"), where the generic
    // `organizations` form is only a fallback.
    const tenant = discovery.tenantId ?? "organizations";
    return {
      accountKind: discovery.kind,
      url: `https://login.microsoftonline.com/${tenant}/adminconsent?${params.toString()}`,
      organisationName: discovery.organisationName,
    };
  }

  /**
   * GET /integrations/microsoft/callback (@Public, ruling 4). ALWAYS returns
   * the web redirect URL â€” ?connected=1 on success, else ?error=<code> â€” so a
   * browser arriving from Microsoft never sees a raw JSON error. Network calls
   * (exchange, profile) run BEFORE the tenant transaction so a slow Microsoft
   * never holds a DB connection; the upsert + audit commit together.
   * Codes/state are never logged (BRD 14).
   */
  async handleCallback(query: MicrosoftCallbackQuery): Promise<string> {
    // Read the state BEFORE branching. Every return below needs the flow to
    // know where it is going, including the decline path, which fires before
    // the state is verified for real. Failure is fine and expected here â€” an
    // expired or absent state simply falls back to the settings page.
    const hints = await this.recoverStateHints(query.state);
    const base = `${this.env.WEB_ORIGIN}${FLOW_RETURN_PATHS[hints.flow]}`;
    if (query.error) {
      // The belt-and-braces branch. The classifier is correct â€” fed AADSTS90094
      // it returns admin_consent_required, verified against deployed staging â€”
      // but Microsoft does NOT send that code to the application (defect F1).
      // At the "Need admin approval" wall the only route back is "Return to the
      // application without granting consent", which arrives as an ordinary
      // decline; 90094 goes to Entra's sign-in log instead. Nothing may depend
      // on this firing.
      if (ADMIN_CONSENT_CODES.test(query.error_description ?? "")) {
        this.logger.info("mailbox connection needs Microsoft 365 admin approval");
        return `${base}?error=admin_consent_required`;
      }
      // So a decline is genuinely ambiguous, and the UI has to offer both
      // readings. Carrying the attempted address through lets it do that
      // properly: the domain decides whether an administrator can even exist.
      this.logger.info("mailbox connection declined at Microsoft");
      const hint = hints.loginHint;
      return `${base}?error=consent_denied${hint ? `&hint=${encodeURIComponent(hint)}` : ""}`;
    }
    if (query.admin_consent) return this.handleAdminConsentReturn(query);
    if (!query.state) return `${base}?error=invalid_state`;
    let claims: OAuthStateClaims;
    try {
      claims = await verifyOAuthState(this.env.OAUTH_STATE_SECRET, query.state);
    } catch {
      return `${base}?error=invalid_state`;
    }
    if (!query.code) return `${base}?error=missing_code`;
    // Re-check authorisation at the moment of the mutation. The state stays
    // valid for 30 minutes and ruling 4 binds it to an ORGANISATION, not to a
    // role â€” so the initiator can be removed from the org or demoted out of
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
      /**
       * This @Public() route calls requirePermission internally, so as of
       * slice 1.6a it inherits the 402 — and its contract is ALWAYS a redirect,
       * never JSON. Falling through to `connect_failed` would have been a
       * redirect too, so nothing would have crashed; it would just have told
       * someone whose organisation switched Invoice Chasing off mid-flow to
       * "try again", which can never work. The same shape of wrong advice as
       * defect F3, so it gets its own code.
       */
      if (error instanceof ModuleNotEntitledException) {
        this.logger.info("mailbox callback rejected â€” organisation is not entitled");
        return `${base}?error=module_not_entitled`;
      }
      if (error instanceof ForbiddenException || error instanceof NotFoundException) {
        this.logger.info("mailbox callback rejected â€” initiator no longer authorised");
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
      // happily and only fails at the first send â€” where it surfaced as
      // "authorisation expired", advice that can never work, so the user
      // looped forever. Prove there is a mailbox BEFORE storing anything:
      // a dead connection stored here is one 1.7 would try to send through.
      await this.graph.probeMailbox(tokens.accessToken);
    } catch (error) {
      if (error instanceof MailboxUnavailableError) {
        this.logger.info("mailbox connection rejected â€” account has no mailbox");
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
      // stamp â€” otherwise a fresh mailbox shows a check time from before the
      // outage that caused the reconnect.
      lastHealthCheckAt: null,
      connectedBy: claims.userId,
    };
    let accountId: string;
    let isNewConnection: boolean;
    try {
      ({ accountId, isNewConnection } = await withTenant(
        this.prisma.db,
        { organisationId: claims.organisationId, userId: claims.userId },
        async (tx) => {
          /**
           * THE SEAT CHECK, and it must serialise (slice 1.6a).
           *
           * A COUNT followed by an INSERT is not atomic just because both sit
           * in a transaction. Two administrators connecting at the same moment
           * each read `count = seats - 1`, each decide there is room, and both
           * insert — the organisation ends up over its limit with no error
           * raised anywhere and nobody ever finds out.
           *
           * `FOR UPDATE` on the module row is what makes the pair atomic: the
           * second transaction blocks until the first commits, then counts
           * again and sees the truth. It locks per organisation, so unrelated
           * customers never queue behind each other.
           */
          const locked = await tx.$queryRaw<{ seats: number }[]>`
            SELECT seats FROM organisation_modules
            WHERE module_key = ${MAILBOX_MODULE} AND deleted_at IS NULL
            FOR UPDATE`;
          const seats = locked[0]?.seats ?? DEFAULT_SEATS;

          // Reconnecting an address reuses its row and consumes no new seat.
          // Case-insensitive to match the database index, so Sara@ and sara@
          // cannot end up as two rows and two seats.
          const existing = await tx.emailAccount.findFirst({
            where: {
              deletedAt: null,
              emailAddress: { equals: profile.emailAddress, mode: "insensitive" },
            },
          });
          if (!existing) {
            const live = await tx.emailAccount.count({ where: { deletedAt: null } });
            if (live >= seats) throw new SeatLimitReachedError();
          }

          const account = existing
            ? await tx.emailAccount.update({ where: { id: existing.id }, data })
            : await tx.emailAccount.create({
                data: {
                  ...data,
                  organisationId: claims.organisationId,
                  createdBy: claims.userId,
                  // The first mailbox an organisation connects becomes the one
                  // 1.7 sends from; later ones are added alongside it.
                  isPrimary: (await tx.emailAccount.count({ where: { deletedAt: null } })) === 0,
                },
              });
          await writeAuditLog(tx, {
            organisationId: claims.organisationId,
            actorUserId: claims.userId,
            action: "mailbox.connected",
            entityType: "email_account",
            entityId: account.id,
            metadata: { emailAddress: profile.emailAddress, provider: "microsoft" },
          });
          return { accountId: account.id, isNewConnection: existing === null };
        },
      ));
    } catch (error) {
      /**
       * Over the seat limit. This runs AFTER the token exchange, because the
       * standing 1.6 ruling forbids a network call inside a transaction — so
       * the rejection discards tokens Microsoft has already issued. They are
       * never stored and never logged, and the grant expires on its own; the
       * connect-time pre-check exists precisely to make this rare.
       */
      if (error instanceof SeatLimitReachedError) {
        this.logger.info("mailbox connection refused â€” seat limit reached");
        return `${base}?error=seat_limit_reached`;
      }
      // A DB outage, or the org being deleted between consent and write.
      // (Revoked membership is caught by the authorisation re-check above, not
      // here â€” RLS alone would let that write through.) Logged with the cause,
      // which the global filter would not do, then redirected, because this
      // route's contract is "always a redirect".
      this.logger.error({ err: error }, "mailbox connection could not be persisted");
      return `${base}?error=connect_failed`;
    }
    this.logger.info({ emailAccountId: accountId }, "mailbox connected");
    // A reconnect is someone repairing a broken grant on the settings page, not
    // someone signing up â€” posting them an email they did not ask for is noise.
    if (!isNewConnection) return `${base}?connected=1`;
    const sent = await this.trySendWelcomeTestEmail(
      claims,
      accountId,
      profile.emailAddress,
      tokens.accessToken,
    );
    return `${base}?connected=1&test_email=${sent ? "sent" : "failed"}`;
  }

  /**
   * The test send that closes a new connection (founder ruling 2026-07-31:
   * send it, say so, move on â€” no "did it arrive?" step, because a
   * self-addressed mail never crosses the internet and cannot realistically
   * fail to arrive once Graph has accepted it).
   *
   * It earns its place because `probeMailbox` proves the account can READ mail
   * and nothing more. Reading and sending genuinely diverge â€” a restricted
   * sender, a shared mailbox, an admin who revoked one permission of four â€” so
   * without this the first proof that sending works would be a real chasing
   * email to a real customer.
   *
   * NEVER THROWS. The mailbox is connected and committed by the time this runs;
   * a failed test send is not a failed connection and must not be reported as
   * one. Nor does it mark the mailbox unhealthy: read access was just proven,
   * so a transient Graph 5xx would otherwise paint a red error across a mailbox
   * that is fine. The user is told, and the manual button retries through the
   * path that does map errors to health.
   *
   * Uses the token already in hand rather than re-reading and decrypting the row
   * written moments ago â€” it was minted seconds back, so refresh-on-use has
   * nothing to do and `ensureAccessToken` would only add a round trip.
   */
  private async trySendWelcomeTestEmail(
    claims: OAuthStateClaims,
    accountId: string,
    emailAddress: string,
    accessToken: string,
  ): Promise<boolean> {
    try {
      await this.graph.sendMail(accessToken, { to: emailAddress, ...TEST_EMAIL });
    } catch (error) {
      this.logger.warn({ err: error }, "mailbox connected but its test email could not be sent");
      return false;
    }
    // Caught separately, and deliberately does NOT change the answer: the mail
    // has left. Reporting "we couldn't send it" because our own bookkeeping
    // failed would tell the customer something untrue about the world.
    try {
      await this.recordTestEmailSent(claims.organisationId, claims.userId, accountId);
    } catch (error) {
      this.logger.error({ err: error }, "test email sent on connect but could not be recorded");
    }
    return true;
  }

  /**
   * The `/adminconsent` return (defect F2). Microsoft sends
   * `admin_consent=True&tenant=<guid>` with no `code` and no `state` of its
   * own, so the schema used to reject it and the administrator who had just
   * approved Eva landed on raw validation JSON.
   *
   * This person is usually NOT an Eva user â€” they are the customer's IT
   * contact, following a forwarded link â€” so the page must never claim a
   * mailbox is now connected. Somebody else still has to do that.
   */
  private async handleAdminConsentReturn(query: MicrosoftCallbackQuery): Promise<string> {
    const approved = `${this.env.WEB_ORIGIN}${ADMIN_CONSENT_RETURN_PATH}`;
    /**
     * Whether our own state survived decides whether we can ATTRIBUTE the
     * approval â€” not whether it happened. Microsoft granted it before
     * redirecting here, so a link that lost its state, or one older than the
     * seven-day token, is still a real approval and the administrator is owed
     * the same confirmation. Telling them "invalid" would be false, and would
     * strand exactly the person the journey depends on.
     *
     * Purpose-scoping still bites where it matters: without a verifiable
     * `admin_consent` token nothing is written, so no organisation can be
     * credited with an approval on the strength of a forged or borrowed state.
     * The page itself carries no organisation name and grants nothing, so
     * showing it to whoever asks costs nothing.
     */
    let claims: OAuthStateClaims | null = null;
    if (query.state) {
      try {
        claims = await verifyOAuthState(this.env.OAUTH_STATE_SECRET, query.state, "admin_consent");
      } catch {
        claims = null;
      }
    }
    if (!claims) {
      this.logger.info("admin consent granted; no verifiable state to attribute it to");
      return approved;
    }
    try {
      await withTenant(
        this.prisma.db,
        { organisationId: claims.organisationId, userId: claims.userId },
        async (tx) => {
          await writeAuditLog(tx, {
            organisationId: claims.organisationId,
            // The initiating Eva user, not the approver â€” the approving admin
            // has no Eva account. The state proves who started the journey.
            actorUserId: claims.userId,
            action: "mailbox.admin_consent_granted",
            entityType: "organisation",
            entityId: claims.organisationId,
            metadata: { tenant: query.tenant ?? null, approvedBy: "microsoft_tenant_admin" },
          });
        },
      );
    } catch (error) {
      // Microsoft has already granted consent; failing to record it must not
      // present that success as a failure to the administrator.
      this.logger.error({ err: error }, "admin consent granted but could not be audited");
    }
    this.logger.info("admin consent granted for organisation");
    return approved;
  }

  /**
   * What a signed state can tell us before the callback commits to a branch:
   * which screen the user started from, and the address they typed.
   *
   * Never throws. A decline, an expired state and an `/adminconsent` return
   * (whose state carries a different purpose and so will not verify here) all
   * still have to render something â€” this only decides where they land and how
   * helpful the copy can be. Verification proper happens on the success path.
   */
  private async recoverStateHints(
    state?: string,
  ): Promise<{ flow: OAuthFlow; loginHint: string | null }> {
    if (!state) return { flow: DEFAULT_OAUTH_FLOW, loginHint: null };
    try {
      const claims = await verifyOAuthState(this.env.OAUTH_STATE_SECRET, state);
      return { flow: claims.flow ?? DEFAULT_OAUTH_FLOW, loginHint: claims.loginHint ?? null };
    } catch {
      return { flow: DEFAULT_OAUTH_FLOW, loginHint: null };
    }
  }

  /** POST .../mailboxes/:mailboxId/disconnect â€” mailbox:manage. Tokens hard-gone
   *  (columns nulled) + soft delete in ONE transaction (ruling 8); the row
   *  stays as audit history and does not block reconnect (partial index). */
  async disconnect(authUser: AuthUser, organisationId: string, mailboxId: string): Promise<void> {
    const user = await this.usersService.resolveOrProvision(authUser);
    await withTenant(this.prisma.db, { organisationId, userId: user.id }, async (tx) => {
      await requirePermission(tx, organisationId, user.id, "mailbox:manage");
      const account = await this.findMailbox(tx, mailboxId);
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
      /**
       * Disconnecting the primary auto-promotes the oldest remaining mailbox
       * rather than refusing. Refusing would force a customer into a two-step
       * dance — promote another, then delete this one — to do something they
       * have already clearly decided on. Leaving the organisation with no
       * primary is worse still: 1.7 would have nothing to send from and the
       * failure would not surface until a reminder was due.
       *
       * Audited, because a mailbox silently becoming the one that speaks to
       * customers is exactly the kind of change someone will later need to
       * explain.
       */
      if (account.isPrimary) {
        const successor = await tx.emailAccount.findFirst({
          where: { deletedAt: null },
          orderBy: { createdAt: "asc" },
        });
        if (successor) {
          await tx.emailAccount.update({
            where: { id: successor.id },
            data: { isPrimary: true },
          });
          await writeAuditLog(tx, {
            organisationId,
            actorUserId: user.id,
            action: "mailbox.primary_changed",
            entityType: "email_account",
            entityId: successor.id,
            metadata: { reason: "previous_primary_disconnected" },
          });
        }
      }
    });
    this.logger.info({ organisationId }, "mailbox disconnected");
  }

  /**
   * PUT .../mailboxes/:mailboxId/primary â€” mailbox:manage. Choose which mailbox
   * slice 1.7 sends from.
   *
   * The demotion and the promotion are one transaction because a partial
   * unique index enforces at most one primary: two primaries is not a state
   * the database will hold, and no primary is a state 1.7 cannot send from.
   */
  async setPrimary(
    authUser: AuthUser,
    organisationId: string,
    mailboxId: string,
  ): Promise<MailboxListDto> {
    const user = await this.usersService.resolveOrProvision(authUser);
    await withTenant(this.prisma.db, { organisationId, userId: user.id }, async (tx) => {
      await requirePermission(tx, organisationId, user.id, "mailbox:manage");
      const account = await this.findMailbox(tx, mailboxId);
      if (account.isPrimary) return;
      // Demote first: the index would reject the promotion otherwise.
      await tx.emailAccount.updateMany({
        where: { deletedAt: null, isPrimary: true },
        data: { isPrimary: false },
      });
      await tx.emailAccount.update({ where: { id: account.id }, data: { isPrimary: true } });
      await writeAuditLog(tx, {
        organisationId,
        actorUserId: user.id,
        action: "mailbox.primary_changed",
        entityType: "email_account",
        entityId: account.id,
        metadata: { reason: "chosen_by_user" },
      });
    });
    return this.listMailboxes(authUser, organisationId);
  }

  /**
   * One mailbox by id, scoped to the caller's organisation by RLS.
   *
   * 404 rather than 403 for a mailbox belonging to someone else: RLS filters
   * it out entirely, so "not found" is not a euphemism here â€” it is what the
   * query genuinely returns (BRD 15).
   */
  private async findMailbox(tx: TenantTx, mailboxId: string): Promise<ConnectedAccount> {
    const account = await tx.emailAccount.findFirst({ where: { id: mailboxId, deletedAt: null } });
    if (!account) throw new NotFoundException("Mailbox not found");
    return account;
  }

  /**
   * POST .../mailboxes/:mailboxId/test-email â€” mailbox:manage. Self-addressed send
   * (ruling 7) proving the full path: valid token â†’ Graph â†’ Sent Items.
   *
   * FOUR independently committed steps, deliberately NOT one transaction
   * (founder ruling 2026-07-30). Sending mail and rotating tokens are both
   * irreversible: a single transaction that failed at COMMIT would leave
   * Microsoft's state ahead of ours â€” mail sent with nothing recorded. That is
   * not hypothetical, 1.5's PR #36 fixed a transaction timing out at
   * transatlantic latency after its work had succeeded. No network call runs
   * inside a transaction here, which is also why the 30s timeout that guarded
   * the old shape is gone.
   *
   * 1.7 MUST follow this shape per reminder: claim in a committed transaction
   * BEFORE sending, then record the outcome after. Steps 3â†’4 stay
   * non-atomic â€” irreducible for any external send â€” so a crash between them
   * leaves a claimed row that must never be auto-retried.
   */
  async sendTestEmail(
    authUser: AuthUser,
    organisationId: string,
    mailboxId: string,
  ): Promise<MailboxTestEmailResultDto> {
    const user = await this.usersService.resolveOrProvision(authUser);
    // 1. Authorize + load. Read-only, so nothing to lose on rollback.
    const account = await withTenant(
      this.prisma.db,
      { organisationId, userId: user.id },
      async (tx) => {
        await requirePermission(tx, organisationId, user.id, "mailbox:manage");
        return this.findMailbox(tx, mailboxId);
      },
    );
    try {
      // 2. Token. Any rotation is committed before we send (see below).
      const accessToken = await this.ensureAccessToken(organisationId, user.id, account);
      // 3. Send. No transaction open.
      await this.graph.sendMail(accessToken, { to: account.emailAddress, ...TEST_EMAIL });
    } catch (error) {
      // The licence was removed after connecting (connect itself now probes,
      // F3). Not auth_expired â€” reconnecting cannot conjure a mailbox â€” so it
      // gets health 'error' and its own advice.
      if (error instanceof MailboxUnavailableError) {
        await this.markUnhealthy(organisationId, user.id, account.id, {
          healthStatus: "error",
          lastError: error.message,
          auditAction: "mailbox.mailbox_unavailable",
        });
        throw new BadRequestException(error.message);
      }
      if (error instanceof ReauthRequiredError) {
        await this.markUnhealthy(organisationId, user.id, account.id, {
          healthStatus: "auth_expired",
          lastError: AUTH_EXPIRED_MESSAGE,
          auditAction: "mailbox.auth_expired",
        });
        throw new BadRequestException(AUTH_EXPIRED_MESSAGE);
      }
      if (error instanceof GraphRequestError) {
        throw new BadGatewayException(
          "Microsoft Graph could not send the test email â€” try again shortly",
        );
      }
      throw error;
    }
    // 4. Record the outcome.
    await this.recordTestEmailSent(organisationId, user.id, account.id);
    return { sent: true, to: account.emailAddress };
  }

  /** Step 4 of a test send: health stamp + audit row, committed together.
   *  Shared by the manual button and the automatic send on first connect, so
   *  "was this mailbox ever proven able to send?" has one answer wherever the
   *  send came from. */
  private async recordTestEmailSent(
    organisationId: string,
    userId: string,
    accountId: string,
  ): Promise<void> {
    await withTenant(this.prisma.db, { organisationId, userId }, async (tx) => {
      await tx.emailAccount.update({
        where: { id: accountId },
        data: { healthStatus: "active", lastHealthCheckAt: new Date(), lastError: null },
      });
      await writeAuditLog(tx, {
        organisationId,
        actorUserId: userId,
        action: "mailbox.test_email_sent",
        entityType: "email_account",
        entityId: accountId,
      });
    });
  }

  /**
   * Refresh-on-use (ruling 10) â€” THE seam 1.7's sender calls before every
   * send. Returns a usable access token, refreshing first when inside the
   * 5-minute expiry buffer, and throwing ReauthRequiredError when Microsoft
   * has revoked the grant.
   *
   * The rotated pair is persisted in its OWN transaction and COMMITTED before
   * this returns. Microsoft has already moved on by then, so the new pair must
   * not be able to roll back with whatever the caller does next. Callers
   * therefore call this BEFORE opening their own transaction â€” never inside
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
   * instead of an opaque 500 beside a card still reading "Connected" â€” which
   * would strand 1.7's sender permanently with no health signal.
   */
  private decryptStoredToken(ciphertext: string, key: string): string {
    try {
      return decryptToken(ciphertext, key);
    } catch (error) {
      if (error instanceof TokenDecryptionError) {
        this.logger.error("stored mailbox token could not be decrypted â€” reconnect required");
        throw new ReauthRequiredError();
      }
      throw error;
    }
  }

  /**
   * Surfaces a broken mailbox to the UI (ruling 10): the status endpoint reads
   * health_status, so the right advice shows without another Graph call.
   * Audited in the same transaction like every other tenant mutation â€” "when
   * did this mailbox die, and why?" must be answerable from the audit trail,
   * not from a mutable column with no timestamp.
   *
   * **Takes the account id, and that is the whole point (slice 1.6a).** It used
   * to re-find "the" live mailbox, which was harmless only while an
   * organisation could have exactly one. With seats it is a real defect: when
   * mailbox B's grant dies, `findFirst` could return mailbox A and mark IT
   * dead instead â€” a healthy mailbox stops sending while the broken one still
   * reads "Connected". Silent, and it only appears once a customer has two.
   */
  private async markUnhealthy(
    organisationId: string,
    userId: string,
    accountId: string,
    outcome: { healthStatus: EmailAccountHealthStatus; lastError: string; auditAction: string },
  ): Promise<void> {
    await withTenant(this.prisma.db, { organisationId, userId }, async (tx) => {
      const account = await tx.emailAccount.findFirst({
        where: { id: accountId, deletedAt: null },
      });
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
