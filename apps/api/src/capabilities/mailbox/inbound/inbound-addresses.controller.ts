import { Controller, Get, Param, ParseUUIDPipe } from "@nestjs/common";
import { OwnedBy } from "../../../common/monitoring/owner.js";
import {
  CurrentAuthUser,
  type AuthUser,
} from "../../../platform/authentication/current-auth-user.decorator.js";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { InboundAddressesService, type InboundAddressView } from "./inbound-addresses.service.js";

/**
 * The front door, as the customer sees it (Slice 3.1b, ruling 29).
 *
 * ⚠️ ONE ROUTE, AND NO WAY TO CHOOSE THE ADDRESS. A customer picking their own
 * local part would be picking a guessable one — that is what makes a readable
 * address safe to publish (ruling 33), and handing the choice over would give
 * it away. Revoking and reissuing is a real need and will get its own route
 * when something can actually go wrong; a button that changes an address
 * printed on a website is not a thing to ship before it is asked for.
 *
 * ⚠️ NO DELETE, EITHER. Migration 0029 takes DELETE away from `eva_app` for
 * both inbound tables: the door we issued and the mail that came through it are
 * how a lead's origin is explained later.
 */
@Controller("organisations/:organisationId/inbound-address")
@OwnedBy("capability:mailbox")
export class InboundAddressesController {
  constructor(private readonly inboundAddresses: InboundAddressesService) {}

  /**
   * The address enquiries should be sent to, issued on first sight.
   *
   * 402 when the organisation does not hold Lead Follow-up by Email, 403 when
   * the caller's role does not carry `leads:read`, and 503 when this
   * environment has no inbound domain configured — three different problems
   * that need three different answers on a screen.
   */
  @Get()
  get(
    @CurrentAuthUser() authUser: AuthUser,
    @Param("organisationId", ParseUUIDPipe) organisationId: string,
  ): Promise<InboundAddressView> {
    return this.inboundAddresses.getOrAllocate(authUser, organisationId);
  }
}
