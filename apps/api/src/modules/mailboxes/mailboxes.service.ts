import { Inject, Injectable } from "@nestjs/common";
// Value import is intentional: NestJS DI reads design:paramtypes metadata,
// which requires the class reference at runtime (not a type-only import).
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PinoLogger } from "nestjs-pino";
import { withTenant } from "@eva/database";
import type { EmailAccountHealthStatus, MailboxStatusDto } from "@eva/types";
import { API_ENV } from "../../config/config.module.js";
import type { ApiEnv } from "../../config/env.js";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PrismaService } from "../../common/database/prisma.service.js";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { UsersService } from "../users/users.service.js";
import { requirePermission } from "../../common/permissions/permissions.js";
import type { AuthUser } from "../authentication/current-auth-user.decorator.js";
import { MICROSOFT_GRAPH_PROVIDER } from "../integrations/microsoft-graph/microsoft-graph-provider.js";
import type { MicrosoftGraphProvider } from "../integrations/microsoft-graph/microsoft-graph-provider.js";

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
}
