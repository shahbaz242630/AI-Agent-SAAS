import { Controller, Get, NotFoundException, Param, ParseUUIDPipe } from "@nestjs/common";
import { withTenant } from "@eva/database";
import { isLeadPlaybookKey, isReplyChannel, type LeadReplyStatusDto } from "@eva/types";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PrismaService } from "../../../common/database/prisma.service.js";
import { OwnedBy } from "../../../common/monitoring/owner.js";
import {
  CurrentAuthUser,
  type AuthUser,
} from "../../../platform/authentication/current-auth-user.decorator.js";
import { requirePermission } from "../../../platform/permissions/permissions.js";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { UsersService } from "../../../platform/users/users.service.js";

/**
 * What happened to one enquiry's reply (slice 3.5a; ruling 90's second
 * leftover — "why Eva did not reply" earns its place on the enquiry page).
 *
 * ⚠️ A PRODUCT ENDPOINT, NOT A FIELD ON THE PLATFORM'S LEAD. The decision row
 * is the lead product's own table, and the platform's `GET /leads/:id` may not
 * read it (`architecture.spec.ts`, the wall). The enquiry page asks two
 * questions of two owners and puts the answers on one screen.
 *
 * ⚠️ 404 FOR AN ENQUIRY THAT IS NOT HERE, `decided: false` FOR ONE EVA HAS NOT
 * LOOKED AT. The two must stay different: the first is a wrong id (or another
 * tenant's, which RLS makes indistinguishable from wrong — BRD 15), the second
 * is an honest state a hand-logged enquiry lives in forever.
 */
@Controller("organisations/:organisationId/lead-reply-decisions")
@OwnedBy("product:lead-follow-up")
export class LeadReplyStatusController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly usersService: UsersService,
  ) {}

  @Get("for-lead/:leadId")
  async forLead(
    @CurrentAuthUser() authUser: AuthUser,
    @Param("organisationId", ParseUUIDPipe) organisationId: string,
    @Param("leadId", ParseUUIDPipe) leadId: string,
  ): Promise<LeadReplyStatusDto> {
    const user = await this.usersService.resolveOrProvision(authUser);
    return withTenant(this.prisma.db, { organisationId, userId: user.id }, async (tx) => {
      await requirePermission(tx, organisationId, user.id, "leads:read");
      const lead = await tx.lead.findFirst({
        where: { id: leadId, deletedAt: null },
        select: { id: true },
      });
      if (!lead) throw new NotFoundException("Enquiry not found");

      const decision = await tx.leadReplyDecision.findFirst({
        where: { leadId, deletedAt: null },
        select: {
          status: true,
          verdict: true,
          reason: true,
          failureReason: true,
          sentAt: true,
          channel: true,
          template: { select: { playbookKey: true } },
        },
      });
      if (!decision) return { decided: false };

      const status = asStatus(decision.status);
      return {
        decided: true,
        status,
        /**
         * The sentence for a reply that did not go: the failure's own words
         * when the verdict was to reply and something stopped it; otherwise
         * the hold's or the refusal's reason. A sent reply has no reason.
         */
        reason:
          status === "sent"
            ? null
            : decision.verdict === "reply"
              ? (decision.failureReason ?? null)
              : decision.reason,
        sentAt: decision.sentAt?.toISOString() ?? null,
        wording:
          decision.template && decision.channel && isReplyChannel(decision.channel)
            ? {
                playbookKey:
                  decision.template.playbookKey && isLeadPlaybookKey(decision.template.playbookKey)
                    ? decision.template.playbookKey
                    : null,
                channel: decision.channel,
              }
            : null,
      };
    });
  }
}

const STATUSES = ["pending", "sent", "failed", "deferred", "not_sent"] as const;

/** The column is a `TEXT` (0036's CHECK is the list); a value outside it is a fault, not a status. */
function asStatus(value: string): (typeof STATUSES)[number] {
  if (!(STATUSES as readonly string[]).includes(value)) {
    throw new Error(
      `lead_reply_decisions.status holds ${value}, which is not a known status — the database CHECK and this list have diverged`,
    );
  }
  return value as (typeof STATUSES)[number];
}
