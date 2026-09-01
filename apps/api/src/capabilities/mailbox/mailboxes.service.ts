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
import { moduleHref } from "@eva/types";
import type {
  ModuleKey,
  EmailAccountHealthStatus,
  MailboxAdminConsentDto,
  MailboxConnectDto,
  MailboxDisconnectResultDto,
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
import { UsersService } from "../../platform/users/users.service.js";
import { requirePermission, type TenantTx } from "../../platform/permissions/permissions.js";
import { ModuleNotEntitledException } from "../../platform/permissions/module-not-entitled.exception.js";
import { auditReassignedByMailbox, writeAuditLog } from "../../platform/audit/audit-log.js";
import {
  decryptToken,
  encryptToken,
  TokenDecryptionError,
} from "../../common/crypto/token-crypto.js";
import type { AuthUser } from "../../platform/authentication/current-auth-user.decorator.js";
import {
  MailProviderRequestError,
  MailboxUnavailableError,
  ReauthRequiredError,
} from "./microsoft-graph/microsoft-graph-provider.js";
import type { MailboxProfile, OAuthTokens } from "./microsoft-graph/microsoft-graph-provider.js";
import { MICROSOFT_DISCOVERY, UNKNOWN_DOMAIN } from "./microsoft-graph/microsoft-discovery.js";
import type { MicrosoftDiscovery } from "./microsoft-graph/microsoft-discovery.js";
import {
  MAIL_PROVIDERS,
  providerFor,
  SendPermissionNotGrantedError,
  type MailProvider,
  type MailProviderKey,
  type MailProviderRegistry,
} from "./mail-provider.js";
import {
  DEFAULT_OAUTH_FLOW,
  signOAuthState,
  verifyConnectState,
  verifyOAuthState,
  type ConnectStateClaims,
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
/**
 * Where the callback sends the browser back to.
 *
 * ⚠️ A FUNCTION OF THE PRODUCT SINCE SLICE 3.1c-0, NOT A CONSTANT TABLE. Mailbox
 * setup lives inside each product now (founder ruling 2026-09-01), so there is
 * no single `/app/settings/mailbox` left to return to — landing there would be
 * a 404, and landing on the OTHER product's screen would show the customer a
 * list that does not contain the mailbox they just connected.
 *
 * ⚠️ `onboarding` IS LEGACY AND NOTHING MINTS IT ANY MORE. Onboarding stopped
 * asking for a mailbox in the same slice. The branch stays so a connection
 * already in flight across that deploy still lands somewhere real.
 *
 * The path is still built here from a closed enum and the signed state — never
 * from anything the caller supplies — so this remains impossible to turn into
 * an open redirect.
 */
function flowReturnPath(flow: OAuthFlow, moduleKey: ModuleKey): string {
  return flow === "onboarding" ? "/app/onboarding" : moduleHref(moduleKey, "mailbox");
}

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

/**
 * ⚠️ `MAILBOX_MODULE = "email_credit_controller"` LIVED HERE UNTIL 2026-09-01
 * AND IS DELETED, NOT MOVED. Every seat check, readiness check and send keyed
 * off that one constant, so a mailbox connected for Lead Follow-up was counted
 * against Invoice Chasing's seats — a product the customer might not even own.
 * The product now travels: on the connect request, on the signed OAuth state,
 * and on the mailbox row itself (migration 0034). If you find yourself wanting
 * a default here again, that is the bug this slice removed.
 */

/**
 * What `resolveSendingMailbox` answered, and HOW (slice 1.6b, Task 6).
 *
 * `source` is not decoration: `substituted` means the mailbox a customer chose
 * is not the one that will send, which is the state ruling 6 requires the
 * settings screen to warn about loudly. Losing that distinction would make a
 * dead mailbox invisible — the reminders would keep going out and nobody would
 * ever reconnect it.
 */
export interface SendingMailboxResolution {
  account: ConnectedAccount;
  /**
   * `allocated` — the client's own mailbox.
   * `default`   — the client was never filed, so the default chases it
   *               (ruling 1: normal, not a problem).
   * `substituted` — the intended mailbox is dead or gone and a healthy one is
   *               standing in (ruling 6: WARN, this needs fixing).
   */
  source: "allocated" | "default" | "substituted";
}

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
    @Inject(MICROSOFT_DISCOVERY) private readonly discovery: MicrosoftDiscovery,
    @Inject(MAIL_PROVIDERS) private readonly providers: MailProviderRegistry,
  ) {
    this.logger.setContext(MailboxesService.name);
  }

  /**
   * The adapter for one mailbox's provider (3.1b step 2).
   *
   * ⚠️ EVERY PROVIDER CALL IN THIS FILE GOES THROUGH HERE — the authorize URL,
   * the callback's exchange / profile / probe / scope check, both sends and the
   * refresh. Nothing reaches a named provider directly, so registering a third
   * one changes this file in no place at all.
   *
   * The rule that makes it safe is where the provider comes FROM: the mailbox
   * row once one exists — a mailbox connected through Microsoft is refreshed and
   * sent through Microsoft forever, whatever else is registered later — and the
   * connect request before it does.
   *
   * ⚠️ THIS REPLACED A DIRECT `MICROSOFT_GRAPH_PROVIDER` INJECTION, REMOVED
   * 2026-08-24. Before Gmail, the four calls with no row to read a provider from
   * went straight to it; they now take the provider as a parameter. The comment
   * that used to sit here still described those four calls as live months after
   * they had moved, which is the failure this note exists to prevent: injecting
   * a named provider back into this service is a regression, not a shortcut.
   *
   * Admin consent and domain discovery are NOT here: Google has no equivalent to
   * Microsoft's model of an organisation approving an app, so they stay on
   * `this.discovery` (`MICROSOFT_DISCOVERY`), a deliberately Microsoft-only port.
   */
  private providerFor(provider: string): MailProvider {
    return providerFor(this.providers, provider);
  }

  /** GET .../mailboxes â€” mailbox:read. Sanitized; tokens NEVER leave the
   *  database (plan Â§8 risk 1). Reads are not audited. */
  async listMailboxes(
    authUser: AuthUser,
    organisationId: string,
    moduleKey: ModuleKey,
  ): Promise<MailboxListDto> {
    const user = await this.usersService.resolveOrProvision(authUser);
    return withTenant(this.prisma.db, { organisationId, userId: user.id }, async (tx) => {
      await requirePermission(tx, organisationId, user.id, "mailbox:read");
      await this.requireProduct(tx, moduleKey);
      // ⚠️ Scoped to ONE product. Mailbox setup now lives inside each product
      // (founder ruling 2026-09-01), so this list is what that product owns —
      // never every mailbox in the organisation.
      const accounts = await tx.emailAccount.findMany({
        where: { deletedAt: null, moduleKey },
        // Primary first, then oldest — a stable order so the list does not
        // reshuffle under the customer between renders.
        orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
      });
      const seats = await this.seatsFor(tx, moduleKey);
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

  /**
   * WHICH MAILBOX CHASES THIS CLIENT, right now (slice 1.6b, Task 6).
   *
   * The seam slice 1.7 calls, once per reminder, and the ONLY place this
   * question is ever answered. It takes a `tx` so the sender can resolve inside
   * its claim transaction; it is a pure read and writes nothing.
   *
   * ⚠️ RESOLVED AT SEND TIME, EVERY TIME — never stored (ALLOCATION-SCOPE trap
   * 1). Stamping the answer onto a client would work perfectly on the day it
   * was written and go wrong months later, after somebody changed their default
   * mailbox, with no error and no failing test. That is why this is a function
   * and not a column.
   *
   * The ladder, and ruling 6 is the third rung:
   *
   *   the client's own mailbox, if live and healthy
   *     ↳ else the organisation's DEFAULT, if live and healthy   (ruling 1)
   *       ↳ else ANY live healthy mailbox, oldest first          (ruling 6)
   *         ↳ else null — the caller must not send
   *
   * Ruling 6 matters more than it looks, and that is why it is here rather than
   * in the sender. Ruling 1 sends every UNALLOCATED client from the default, so
   * a dead default does not strand a handful of specially-filed clients — it
   * strands everyone who was never filed, which is most of them. Sending from
   * another address belonging to the same business is the smaller harm, and it
   * is visible and correctable; a silent revenue stall is neither.
   *
   * `null` is a real outcome, not an error: an organisation whose every mailbox
   * is dead must not send from nowhere. What 1.7 does with it is 1.7's
   * decision; this function's job is to answer honestly.
   */
  async resolveSendingMailbox(
    tx: TenantTx,
    organisationId: string,
    moduleKey: ModuleKey,
    customer: { organisationId: string; emailAccountId: string | null },
  ): Promise<SendingMailboxResolution | null> {
    /**
     * ⚠️ The caller must not hand us a customer from a different tenant than
     * the transaction is scoped to, and this is the ONLY place that can tell.
     *
     * RLS hides the other organisation's mailboxes rather than erroring, so
     * without this guard a mis-scoped customer would silently fall past its own
     * (invisible) allocation, match THIS organisation's primary, and return it
     * as a `substituted` mailbox. Org A's debtor would then be chased from org
     * B's address — the failure migration 0020's own comment calls the worst
     * this product could have. The composite foreign key cannot catch it: it
     * constrains what is written, not what a read-only resolver returns.
     *
     * Loud, not a null: this can only happen through a caller bug (1.7 batching
     * per organisation), and a quiet answer would hide it until a customer
     * noticed. `ensureAccessToken` guards itself the same way.
     */
    if (customer.organisationId !== organisationId) {
      throw new Error("resolveSendingMailbox: customer belongs to a different organisation");
    }
    /**
     * One query, then decide in memory. An organisation holds at most a handful
     * of mailboxes (it pays per seat), and this runs once per reminder — three
     * round trips to walk the ladder would cost more than reading all of them.
     *
     * Ordered oldest-first so the ruling-6 substitution is DETERMINISTIC: the
     * same client must not be chased from a different address on each run, or
     * the debtor sees a conversation scattered across mailboxes.
     */
    const live = await tx.emailAccount.findMany({
      where: { deletedAt: null, moduleKey },
      orderBy: { createdAt: "asc" },
    });
    const healthy = live.filter((account) => account.healthStatus === "active");

    /**
     * The per-client filing (slice 1.6b, ruling 1) — "chase Bob's Builders from
     * accounts@, everyone else from mike@".
     *
     * ⚠️ FOUNDER RULING 2026-09-01: THIS FILING IS AN INVOICE CHASING FEATURE,
     * AND NOTHING ELSE READS IT. Clients are shared across products (ruling 15)
     * but a mailbox now belongs to one product, so a shared client filed under
     * Invoice Chasing's `accounts@` leaves every other product with no answer.
     * Lead Follow-up ignores the filing entirely and replies from its own
     * product default.
     *
     * ⚠️ AND THAT COSTS NO `if` AND NO FLAG, WHICH IS WHY IT IS WRITTEN THIS
     * WAY. `live` is already scoped to the product above, so a mailbox filed
     * against a DIFFERENT product simply is not in the candidate set and this
     * `find` cannot match it. The rule enforces itself through the same filter
     * that makes sending product-scoped, rather than through a second branch
     * that could later be edited apart from it.
     */
    if (customer.emailAccountId) {
      const allocated = healthy.find((account) => account.id === customer.emailAccountId);
      if (allocated) return { account: allocated, source: "allocated" };
    }

    /**
     * The default. Reached both by a client that was never filed (ruling 1) and
     * by one whose own mailbox is dead — and in the second case it is already a
     * substitution, so it is reported as one. The customer needs to know their
     * filing is not being honoured.
     */
    const wasAllocated = customer.emailAccountId !== null;
    const primary = healthy.find((account) => account.isPrimary);
    if (primary) {
      return { account: primary, source: wasAllocated ? "substituted" : "default" };
    }

    // Ruling 6's last rung: the default itself is dead or gone.
    const standIn = healthy[0];
    if (standIn) return { account: standIn, source: "substituted" };

    return null;
  }

  /**
   * "Does this organisation actually hold the product this mailbox is for?"
   *
   * ⚠️ NEEDED THE MOMENT MAILBOXES BECAME PER-PRODUCT (slice 3.1c-0), AND NOT
   * BEFORE. `requirePermission` asks whether the organisation holds ANY product
   * granting `mailbox:manage` — which was the whole question while a mailbox
   * belonged to the organisation. It is now only half of it: a customer who
   * bought Lead Follow-up alone holds that permission, and without this check
   * could connect a mailbox FOR INVOICE CHASING — a product they never bought,
   * consuming a seat on a module row that does not exist and so falls back to
   * the default of one.
   *
   * 402 rather than 403, the 1.6a distinction: "your organisation hasn't got
   * this product" is an upgrade prompt, not "ask your owner for permission".
   * It is the code the mailbox screen already renders as "you don't have X, so
   * there's no mailbox to connect yet".
   */
  private async requireProduct(tx: TenantTx, moduleKey: ModuleKey): Promise<void> {
    const held = await tx.organisationModule.findFirst({
      where: { moduleKey, enabled: true, deletedAt: null },
    });
    if (!held) throw new ModuleNotEntitledException([moduleKey]);
  }

  /** Seats bought for the mailbox-bearing product. Fails CLOSED: a missing or
   *  disabled module row reads as the default rather than as unlimited. */
  private async seatsFor(tx: TenantTx, moduleKey: ModuleKey): Promise<number> {
    const module = await tx.organisationModule.findFirst({
      where: { moduleKey, deletedAt: null },
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
    input: MailboxConnectInput,
  ): Promise<MailboxConnectDto> {
    const user = await this.usersService.resolveOrProvision(authUser);
    await withTenant(this.prisma.db, { organisationId, userId: user.id }, async (tx) => {
      await requirePermission(tx, organisationId, user.id, "mailbox:manage");
      await this.requireProduct(tx, input.moduleKey);
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
      const seats = await this.seatsFor(tx, input.moduleKey);
      // Per product: this pre-check must agree with the authoritative one in
      // the callback, and that one counts only this product's mailboxes.
      const live = await tx.emailAccount.findMany({
        where: { deletedAt: null, moduleKey: input.moduleKey },
        select: { id: true, emailAddress: true },
      });
      /**
       * A replace must name a mailbox that actually exists here. 404 rather
       * than 403 — under RLS another tenant's mailbox is invisible, so that is
       * what the query genuinely returns (BRD 15).
       */
      if (
        input.replacesMailboxId !== undefined &&
        !live.some((account) => account.id === input.replacesMailboxId)
      ) {
        throw new NotFoundException("Mailbox not found");
      }
      const reconnecting =
        input.emailAddress !== undefined &&
        live.some(
          (account) =>
            account.emailAddress.toLowerCase() === input.emailAddress!.trim().toLowerCase(),
        );
      /**
       * ⚠️ THE SEAT TRAP (slice 1.6b, plan Task 5). A replace frees the seat it
       * takes, so the mailbox being replaced must not be counted against the
       * limit.
       *
       * Without this exemption an organisation sitting at its seat limit — the
       * normal state for anyone who bought exactly what they use — could never
       * replace an address. They would be told to disconnect one first, which
       * is the very thing ruling 3 forbids, because disconnecting drops every
       * allocation to the default in the gap.
       */
      const occupied = input.replacesMailboxId ? live.length - 1 : live.length;
      if (!reconnecting && occupied >= seats) {
        throw new BadRequestException(
          `All ${seats} mailbox ${seats === 1 ? "seat is" : "seats are"} in use. Disconnect one, or add a seat, before connecting another.`,
        );
      }
    });
    const state = await signOAuthState(this.env.OAUTH_STATE_SECRET, {
      organisationId,
      userId: user.id,
      nonce: randomUUID(),
      // Which product this mailbox is for — see the claim's note in
      // oauth-state.ts. Not optional for a connect, and never guessed.
      moduleKey: input.moduleKey,
      ...(input.emailAddress ? { loginHint: input.emailAddress } : {}),
      // Rides on the state because Microsoft returns `state` untouched and
      // nothing else survives the round trip â€” the browser is at Microsoft in
      // between, so we cannot hold this in a cookie we control.
      ...(input.flow ? { flow: input.flow } : {}),
      ...(input.replacesMailboxId ? { replacesMailboxId: input.replacesMailboxId } : {}),
    });
    const chosen = input.provider ?? "microsoft";
    /**
     * ⚠️ REFUSED WHEN UNCONFIGURED, NOT SILENTLY ATTEMPTED. Without a client id
     * we would build an authorize URL with an empty one and send the customer
     * to a Google error page they cannot act on — having already told them Eva
     * supports Gmail. The same shape as `INBOUND_EMAIL_DOMAIN`: optional at
     * boot so the API still starts, refused at the moment it is needed.
     */
    if (chosen === "google" && !this.env.GOOGLE_CLIENT_ID) {
      throw new BadRequestException("Gmail is not configured on this environment yet");
    }

    /**
     * ⚠️ THE PROVIDER IS CHOSEN HERE AND NEVER AGAIN. Each provider has its own
     * registered redirect URI, so the callback route already knows which one
     * came back — the state does not need to carry it, and deliberately does
     * not: a provider name riding in a signed token is one more thing that can
     * disagree with the URL the browser actually returned to.
     */
    return {
      authorizeUrl: this.providerFor(chosen).buildAuthorizeUrl(state, {
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
  async handleCallback(
    query: MicrosoftCallbackQuery,
    provider: MailProviderKey = "microsoft",
  ): Promise<string> {
    // Read the state BEFORE branching. Every return below needs the flow to
    // know where it is going, including the decline path, which fires before
    // the state is verified for real. Failure is fine and expected here â€” an
    // expired or absent state simply falls back to the settings page.
    const hints = await this.recoverStateHints(query.state);
    /**
     * ⚠️ EVERY RETURN FROM THIS METHOD CARRIES THE PROVIDER, AND THAT IS A
     * FOUNDER RULING (2026-08-22): "they should be separate, no crossing
     * paths."
     *
     * The web could not tell them apart before. `handleCallback` is shared, so
     * a Gmail customer who pressed Cancel at Google was handed `consent_denied`
     * — a code whose entire copy is about a Microsoft 365 administrator — and
     * shown an Entra approval panel. Wrong provider, wrong story, and
     * cancelling is the single most likely way to fail this screen.
     *
     * It is baked into `base` rather than added at each `return` because there
     * are fifteen of them and the failure mode of forgetting one is silent: the
     * page falls back to whatever it assumed before, which is Microsoft.
     * Everything downstream therefore appends with `&`.
     */
    const base = `${this.env.WEB_ORIGIN}${
      /**
       * ⚠️ NULL WHEN THE STATE WOULD NOT VERIFY, AND THE HUB IS THE HONEST
       * ANSWER THEN. `hints` is a best-effort read taken BEFORE verification so
       * a failure can still be explained; an unreadable state names no product,
       * and guessing one would drop the customer on a mailbox screen belonging
       * to something they were not connecting. `/app` is where they choose.
       */
      hints.moduleKey ? flowReturnPath(hints.flow, hints.moduleKey) : "/app"
    }?provider=${provider}`;
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
        return `${base}&error=admin_consent_required`;
      }
      // So a decline is genuinely ambiguous, and the UI has to offer both
      // readings. Carrying the attempted address through lets it do that
      // properly: the domain decides whether an administrator can even exist.
      this.logger.info("mailbox connection declined at Microsoft");
      const hint = hints.loginHint;
      return `${base}&error=consent_denied${hint ? `&hint=${encodeURIComponent(hint)}` : ""}`;
    }
    if (query.admin_consent) return this.handleAdminConsentReturn(query);
    if (!query.state) return `${base}&error=invalid_state`;
    let claims: ConnectStateClaims;
    try {
      claims = await verifyConnectState(this.env.OAUTH_STATE_SECRET, query.state);
    } catch {
      return `${base}&error=invalid_state`;
    }
    if (!query.code) return `${base}&error=missing_code`;
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
          // Re-checked at the moment of the write, not just at connect: the
          // product may have been switched off during the provider round trip,
          // and the callback maps this to `?error=module_not_entitled`.
          await this.requireProduct(tx, claims.moduleKey);
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
        return `${base}&error=module_not_entitled`;
      }
      if (error instanceof ForbiddenException || error instanceof NotFoundException) {
        this.logger.info("mailbox callback rejected â€” initiator no longer authorised");
        return `${base}&error=not_authorised`;
      }
      this.logger.error({ err: error }, "mailbox callback authorisation check failed");
      return `${base}&error=connect_failed`;
    }
    let tokens: OAuthTokens;
    let profile: MailboxProfile;
    try {
      tokens = await this.providerFor(provider).exchangeCode(query.code);
      profile = await this.providerFor(provider).getProfile(tokens.accessToken);
      // Defect F3: an account with no Exchange licence consents perfectly
      // happily and only fails at the first send â€” where it surfaced as
      // "authorisation expired", advice that can never work, so the user
      // looped forever. Prove there is a mailbox BEFORE storing anything:
      // a dead connection stored here is one 1.7 would try to send through.
      await this.providerFor(provider).probeMailbox(tokens.accessToken);
      /**
       * The same rule as the probe above, one question further on: the probe
       * asks whether there is a mailbox, this asks whether we were allowed to
       * send from it. Google can answer "yes" to the first and "no" to the
       * second, because its consent screen lists the send permission as its own
       * unticked checkbox — so the round trip succeeds and every send 403s.
       *
       * Checked here, before the write, for the reason F3 established and for
       * one more: this path REPLACES an existing mailbox further down, soft-
       * deleting the old row. Storing first and discovering the problem
       * afterwards would take a customer's working mailbox away and give them a
       * mute one in exchange.
       */
      this.providerFor(provider).assertSendPermission(tokens.scopes);
    } catch (error) {
      if (error instanceof SendPermissionNotGrantedError) {
        this.logger.info("mailbox connection rejected - send permission not granted");
        return `${base}&error=send_permission_denied`;
      }
      if (error instanceof MailboxUnavailableError) {
        this.logger.info("mailbox connection rejected â€” account has no mailbox");
        return `${base}&error=mailbox_unavailable`;
      }
      this.logger.warn({ err: error }, "mailbox token exchange/profile failed");
      return `${base}&error=exchange_failed`;
    }
    const key = this.env.TOKEN_ENCRYPTION_KEY;
    const data = {
      provider,
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
    let replaceDegraded: boolean;
    try {
      ({ accountId, isNewConnection, replaceDegraded } = await withTenant(
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
            WHERE module_key = ${claims.moduleKey} AND deleted_at IS NULL
            FOR UPDATE`;
          const seats = locked[0]?.seats ?? DEFAULT_SEATS;

          /**
           * The mailbox this connection replaces (ruling 3), re-read INSIDE the
           * transaction rather than trusted from the state. It is signed, so it
           * is ours — but a colleague may have disconnected that mailbox during
           * the Microsoft round trip, and a replace of something that is
           * already gone must degrade to a plain connect, not fail.
           */
          const replacing = claims.replacesMailboxId
            ? await tx.emailAccount.findFirst({
                // Scoped to the product as well as the id: a state naming a
                // mailbox belonging to the OTHER product must not be able to
                // replace it, and re-checking here costs nothing.
                where: {
                  id: claims.replacesMailboxId,
                  moduleKey: claims.moduleKey,
                  deletedAt: null,
                },
              })
            : null;

          /**
           * Reconnecting an address reuses its row and consumes no new seat.
           * Case-insensitive to match the database index, so Sara@ and sara@
           * cannot end up as two rows and two seats.
           *
           * ⚠️ SCOPED TO THE PRODUCT, AND THIS IS THE LINE THE WHOLE RULING
           * RESTS ON. Without `moduleKey` here, a customer connecting
           * `mike@mikesplumbing.co.uk` to Lead Follow-up would match the row
           * Invoice Chasing already owns and UPDATE it — silently moving their
           * chasing mailbox to the other product instead of creating the second
           * connection, with no second seat, no second grant, and no error.
           * The founder's ruling of 2026-09-01 is precisely that the same
           * address on two products is two independent mailboxes.
           */
          const existing = await tx.emailAccount.findFirst({
            where: {
              deletedAt: null,
              moduleKey: claims.moduleKey,
              emailAddress: { equals: profile.emailAddress, mode: "insensitive" },
            },
          });
          if (!existing) {
            // The replaced mailbox is about to free its seat, so it must not be
            // counted against the limit — see the trap note in `connect`. This
            // is the authoritative check; the one in `connect` is only friendly.
            // Counted per product: a seat is one address on ONE product.
            const live = await tx.emailAccount.count({
              where: {
                deletedAt: null,
                moduleKey: claims.moduleKey,
                ...(replacing ? { id: { not: replacing.id } } : {}),
              },
            });
            if (live >= seats) throw new SeatLimitReachedError();
          }

          const account = existing
            ? await tx.emailAccount.update({ where: { id: existing.id }, data })
            : await tx.emailAccount.create({
                data: {
                  ...data,
                  organisationId: claims.organisationId,
                  moduleKey: claims.moduleKey,
                  createdBy: claims.userId,
                  // The first mailbox a PRODUCT connects becomes the one it
                  // sends from; later ones are added alongside it. Per product,
                  // because each product has its own default (migration 0034) —
                  // org-wide, the second product could never get one.
                  isPrimary:
                    (await tx.emailAccount.count({
                      where: { deletedAt: null, moduleKey: claims.moduleKey },
                    })) === 0,
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

          /**
           * THE REPLACE (ruling 3): the clients follow the address.
           *
           * All of it in this one transaction, because a half-done replace is
           * the worst of both worlds — the old mailbox gone and its clients
           * still pointing at it, or the new one live with nobody filed under
           * it. Skipped when the "replacement" turns out to be the same row,
           * which happens if someone reconnects the very address they meant to
           * replace; that is a reconnect and needs none of this.
           */
          if (replacing && replacing.id !== account.id) {
            // Audit first, then move — same reason as disconnect: the
            // insert-select reads clients by their CURRENT allocation, and it
            // streams rather than loading an unbounded book into memory.
            const carried = await auditReassignedByMailbox(tx, {
              organisationId: claims.organisationId,
              actorUserId: claims.userId,
              fromEmailAccountId: replacing.id,
              toEmailAccountId: account.id,
              reason: "mailbox_replaced",
            });
            await tx.customer.updateMany({
              where: { emailAccountId: replacing.id },
              data: { emailAccountId: account.id },
            });
            /**
             * The default status follows too. Demote first: a partial unique
             * index allows only one primary per organisation, so promoting
             * before demoting is a constraint violation rather than a swap.
             */
            if (replacing.isPrimary) {
              await tx.emailAccount.update({
                where: { id: replacing.id },
                data: { isPrimary: false },
              });
              await tx.emailAccount.update({
                where: { id: account.id },
                data: { isPrimary: true },
              });
              /**
               * Audited as its own event, not left implicit in `mailbox.replaced`.
               *
               * The default is the mailbox that chases every UNFILED client
               * (ruling 1) — usually most of the book — so this is the change
               * somebody will later need explained. The two other paths that
               * move it (`setPrimary`, and disconnect's auto-promotion) both
               * write this row; a replace that did not would leave the question
               * "when did our unfiled clients start being chased from here?"
               * answerable only by someone who already knew to look for
               * `mailbox.replaced` and to infer it.
               */
              await writeAuditLog(tx, {
                organisationId: claims.organisationId,
                actorUserId: claims.userId,
                action: "mailbox.primary_changed",
                entityType: "email_account",
                entityId: account.id,
                metadata: { reason: "mailbox_replaced", previousMailboxId: replacing.id },
              });
            }
            // Tokens hard-gone, row kept as history — the same contract as a
            // plain disconnect (ruling 8).
            await tx.emailAccount.update({
              where: { id: replacing.id },
              data: {
                accessTokenEncrypted: null,
                refreshTokenEncrypted: null,
                tokenExpiresAt: null,
                deletedAt: new Date(),
              },
            });
            await writeAuditLog(tx, {
              organisationId: claims.organisationId,
              actorUserId: claims.userId,
              action: "mailbox.replaced",
              entityType: "email_account",
              entityId: account.id,
              metadata: {
                replacedMailboxId: replacing.id,
                replacedEmailAddress: replacing.emailAddress,
                clientsCarried: carried,
              },
            });
          }

          /**
           * A replace was ASKED FOR and could not be performed — the mailbox it
           * named was disconnected during the Microsoft round trip (by a
           * colleague, a second tab, or a duplicate click).
           *
           * Degrading to a plain connect is the right behaviour; doing it
           * SILENTLY was not. The outcome is exactly what ruling 3 forbids: the
           * old mailbox is gone, its clients fell back to the default, and the
           * user believes their book followed the new address. Worse, the audit
           * trail showed a single ordinary `mailbox.connected` row — nothing
           * anywhere recorded that a replace had been requested and skipped.
           */
          const replaceDegraded = claims.replacesMailboxId !== undefined && replacing === null;
          if (replaceDegraded) {
            await writeAuditLog(tx, {
              organisationId: claims.organisationId,
              actorUserId: claims.userId,
              action: "mailbox.replace_skipped",
              entityType: "email_account",
              entityId: account.id,
              metadata: {
                requestedReplacementOf: claims.replacesMailboxId,
                reason: "target_already_disconnected",
              },
            });
          }
          return { accountId: account.id, isNewConnection: existing === null, replaceDegraded };
        },
        /**
         * 30s, not Prisma's 5s default (the 1.5 PR #36 lesson). A replace grew
         * this transaction from about five statements to thirteen, one of them
         * a `createMany` of one audit row per carried client. Timing out here
         * is worse than anywhere else in the codebase: the Microsoft tokens
         * have already been exchanged and are discarded on rollback, so the
         * customer must walk the entire consent journey again — including the
         * administrator-approval detour if their tenant requires one.
         */
        { timeout: 30_000 },
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
        return `${base}&error=seat_limit_reached`;
      }
      // A DB outage, or the org being deleted between consent and write.
      // (Revoked membership is caught by the authorisation re-check above, not
      // here â€” RLS alone would let that write through.) Logged with the cause,
      // which the global filter would not do, then redirected, because this
      // route's contract is "always a redirect".
      this.logger.error({ err: error }, "mailbox connection could not be persisted");
      return `${base}&error=connect_failed`;
    }
    this.logger.info({ emailAccountId: accountId, replaceDegraded }, "mailbox connected");
    // Carried on every return below: the customer asked to swap an address and
    // did not get a swap, and finding that out from a confused debtor months
    // later is the failure ruling 3 exists to prevent.
    const degraded = replaceDegraded ? "&replace=degraded" : "";
    // A reconnect is someone repairing a broken grant on the settings page, not
    // someone signing up â€” posting them an email they did not ask for is noise.
    if (!isNewConnection) return `${base}&connected=1${degraded}`;
    const sent = await this.trySendWelcomeTestEmail(
      claims,
      accountId,
      profile.emailAddress,
      tokens.accessToken,
      provider,
    );
    return `${base}&connected=1&test_email=${sent ? "sent" : "failed"}${degraded}`;
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
    provider: MailProviderKey,
  ): Promise<boolean> {
    try {
      await this.providerFor(provider).sendMail(accessToken, {
        from: emailAddress,
        to: emailAddress,
        ...TEST_EMAIL,
      });
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
  ): Promise<{ flow: OAuthFlow; loginHint: string | null; moduleKey: ModuleKey | null }> {
    const nothing = { flow: DEFAULT_OAUTH_FLOW, loginHint: null, moduleKey: null };
    if (!state) return nothing;
    try {
      const claims = await verifyOAuthState(this.env.OAUTH_STATE_SECRET, state);
      return {
        flow: claims.flow ?? DEFAULT_OAUTH_FLOW,
        loginHint: claims.loginHint ?? null,
        // Which product's screen to return to. Absent only when the state did
        // not verify, which the caller handles by sending them to the hub.
        moduleKey: claims.moduleKey ?? null,
      };
    } catch {
      return nothing;
    }
  }

  /** POST .../mailboxes/:mailboxId/disconnect â€” mailbox:manage. Tokens hard-gone
   *  (columns nulled) + soft delete in ONE transaction (ruling 8); the row
   *  stays as audit history and does not block reconnect (partial index). */
  async disconnect(
    authUser: AuthUser,
    organisationId: string,
    mailboxId: string,
  ): Promise<MailboxDisconnectResultDto> {
    const user = await this.usersService.resolveOrProvision(authUser);
    const result = await withTenant(
      this.prisma.db,
      { organisationId, userId: user.id },
      async (tx) => {
        await requirePermission(tx, organisationId, user.id, "mailbox:manage");
        const account = await this.findMailbox(tx, mailboxId);

        /**
         * The clients fall back to the default, and we COUNT them (ruling 3).
         *
         * Never silent: discovering months later that a book of clients quietly
         * changed the address they are chased from is the failure this number
         * exists to prevent. The count is of LIVE clients, because those are the
         * ones that will actually be chased from somewhere else — soft-deleted
         * rows are cleared too so nothing dangles, but nobody needs telling
         * about them.
         *
         * Clearing to NULL rather than to the default's id is ruling 1 and trap
         * 1 together: NULL resolves at send time, an id freezes today's default
         * into history.
         */
        /**
         * Audit FIRST, then clear — the insert-select reads the clients by
         * their current allocation, and after the update there is nothing left
         * to select. Its affected-row count IS the number of live clients that
         * moved, so no separate COUNT is needed.
         *
         * Streamed rather than loaded: a customer with 10,000 filed clients
         * would otherwise pull 10,000 ids across the wire and push 10,000 rows
         * back inside an open transaction (unbounded, unlike allocation which
         * the request schema caps at 500).
         */
        const movedCount = await auditReassignedByMailbox(tx, {
          organisationId,
          actorUserId: user.id,
          fromEmailAccountId: account.id,
          toEmailAccountId: null,
          reason: "mailbox_disconnected",
        });
        await tx.customer.updateMany({
          where: { emailAccountId: account.id },
          data: { emailAccountId: null },
        });

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
          /**
           * ⚠️ THE SUCCESSOR COMES FROM THE SAME PRODUCT. Unscoped, disconnecting
           * Invoice Chasing's default would promote a mailbox the customer
           * connected for Lead Follow-up — handing one product's chasers to the
           * other product's address, silently, with an audit row saying only
           * that the primary changed. The two products share nothing (founder
           * ruling 2026-09-01), and "nothing" includes each other's fallbacks.
           */
          const successor = await tx.emailAccount.findFirst({
            where: { deletedAt: null, moduleKey: account.moduleKey },
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

        /**
         * Read AFTER the promotion above, so it names where the clients actually
         * land rather than the mailbox that just went. Null when this was the
         * last one — an organisation with nothing connected has no default, and
         * saying so is more honest than naming an address that no longer exists.
         */
        const fallback = await tx.emailAccount.findFirst({
          // Scoped: an organisation now holds one primary PER PRODUCT
          // (migration 0034), so "the primary" without a product would name
          // whichever row came back first and could report the other product's
          // address as where these clients had moved to.
          where: { deletedAt: null, isPrimary: true, moduleKey: account.moduleKey },
          select: { emailAddress: true },
        });
        /**
         * The clients nobody ever filed ALSO change address when the mailbox
         * being disconnected is the default — and by ruling 1 they are usually
         * the majority, not an afterthought. Counting only the filed ones would
         * report "0 clients moved" while several hundred quietly started being
         * chased from somewhere else, which is the precise silence ruling 3
         * exists to forbid.
         *
         * Zero when a non-default mailbox goes: the default those clients fall
         * back to has not moved, so nothing about them changed.
         */
        const unfiledClientsMoved = account.isPrimary
          ? await tx.customer.count({ where: { deletedAt: null, emailAccountId: null } })
          : 0;
        return {
          unfiledClientsMoved,
          clientsMoved: movedCount,
          movedToEmailAddress: fallback?.emailAddress ?? null,
        };
      },
    );
    this.logger.info({ organisationId, clientsMoved: result.clientsMoved }, "mailbox disconnected");
    return result;
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
    // Returned from the transaction rather than read after it: the reply lists
    // THIS mailbox's product, and only the transaction can see which that is.
    const moduleKey = await withTenant(
      this.prisma.db,
      { organisationId, userId: user.id },
      async (tx): Promise<ModuleKey> => {
        await requirePermission(tx, organisationId, user.id, "mailbox:manage");
        const account = await this.findMailbox(tx, mailboxId);
        if (account.isPrimary) return account.moduleKey as ModuleKey;
        /**
         * Demote first: the index would reject the promotion otherwise.
         *
         * ⚠️ WITHIN THIS MAILBOX'S PRODUCT ONLY. Unscoped, this demoted EVERY
         * primary in the organisation — so choosing a new default for Invoice
         * Chasing would silently clear Lead Follow-up's, and that product would
         * fall back to "oldest healthy mailbox" with nothing on any screen to say
         * why. The founder's rule of 2026-09-01 is that neither product can move
         * the other; this is one of the two places that could.
         */
        await tx.emailAccount.updateMany({
          where: { deletedAt: null, isPrimary: true, moduleKey: account.moduleKey },
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
        return account.moduleKey as ModuleKey;
      },
    );
    return this.listMailboxes(authUser, organisationId, moduleKey);
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
      await this.providerFor(account.provider).sendMail(accessToken, {
        from: account.emailAddress,
        to: account.emailAddress,
        ...TEST_EMAIL,
      });
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
      if (error instanceof MailProviderRequestError) {
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
    const tokens = await this.providerFor(account.provider).refreshTokens(
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
