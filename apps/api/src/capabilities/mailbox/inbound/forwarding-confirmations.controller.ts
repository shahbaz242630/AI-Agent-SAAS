import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
} from "@nestjs/common";
import { OwnedBy } from "../../../common/monitoring/owner.js";
import {
  CurrentAuthUser,
  type AuthUser,
} from "../../../platform/authentication/current-auth-user.decorator.js";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  ForwardingConfirmationsService,
  type ForwardingRequestView,
} from "./forwarding-confirmations.service.js";

/**
 * The guided forwarding screen's API (Slice 3.1b, step 4).
 *
 * ⚠️ THERE IS NO ROUTE THAT CONFIRMS AN ARBITRARY URL, AND THERE MUST NEVER BE.
 * Everything here acts on a request Google already sent US — the link came from
 * a message delivered to an address we own, was parsed by
 * `gmail-forwarding-confirmation.ts` and stored. A route that accepted a URL
 * from the caller would turn this service into an open fetcher of anything
 * shaped like a Google link, with our network on the other end of it.
 */
@Controller("organisations/:organisationId/forwarding")
@OwnedBy("capability:mailbox")
export class ForwardingConfirmationsController {
  constructor(private readonly forwarding: ForwardingConfirmationsService) {}

  /**
   * "I am setting forwarding up now" — opens the window in which Eva answers
   * Google for them (`leads:write`).
   *
   * ⚠️ 200, NOT 201. Nothing is created; a window is opened on a row that
   * already exists. The connect endpoint learned this the same way, at the cost
   * of a red test run.
   */
  @Post("arm")
  @HttpCode(200)
  arm(
    @CurrentAuthUser() authUser: AuthUser,
    @Param("organisationId", ParseUUIDPipe) organisationId: string,
  ): Promise<{ armedUntil: Date }> {
    return this.forwarding.arm(authUser, organisationId);
  }

  /** Every request that has ever arrived for this organisation (`leads:read`). */
  @Get("requests")
  list(
    @CurrentAuthUser() authUser: AuthUser,
    @Param("organisationId", ParseUUIDPipe) organisationId: string,
  ): Promise<ForwardingRequestView[]> {
    return this.forwarding.list(authUser, organisationId);
  }

  /**
   * "Yes, that was me" / "No, it wasn't" (`leads:write`).
   *
   * ⚠️ ONE ROUTE WITH A DECISION IN THE BODY, NOT TWO VERBS. A `confirm` route
   * and a `decline` route are two ways to reach the same row, and the day
   * somebody adds a guard to one of them is the day the other is the way in.
   */
  @Post("requests/:requestId")
  @HttpCode(200)
  settle(
    @CurrentAuthUser() authUser: AuthUser,
    @Param("organisationId", ParseUUIDPipe) organisationId: string,
    @Param("requestId", ParseUUIDPipe) requestId: string,
    @Body() body: { decision?: unknown },
  ): Promise<ForwardingRequestView> {
    /**
     * ⚠️ REFUSED RATHER THAN DEFAULTED, AND THE DEFAULT THAT WAS HERE FIRST IS
     * WHY THIS COMMENT EXISTS. Reading anything unrecognised as "decline" looks
     * like the safe direction — it is the choice that grants nothing — but
     * `declined` is TERMINAL. A misspelled field would permanently refuse a
     * request the customer was trying to approve, and the screen would show
     * them a decision they never made. Neither answer is safe to guess.
     */
    const decision = body?.decision;
    if (decision !== "confirm" && decision !== "decline") {
      throw new BadRequestException("decision must be 'confirm' or 'decline'");
    }
    return this.forwarding.settle(authUser, organisationId, requestId, decision);
  }
}
