import { Body, Controller, Get, Param, ParseUUIDPipe, Put } from "@nestjs/common";
import { allocateClientsRequestSchema, type AllocateClientsRequest } from "@eva/validation";
import type { AllocateClientsResultDto, CustomerAllocationListDto } from "@eva/types";
import { ZodValidationPipe } from "../../common/validation/zod-validation.pipe.js";
import { CurrentAuthUser, type AuthUser } from "../authentication/current-auth-user.decorator.js";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { AllocationService } from "./allocation.service.js";
import { OwnedBy } from "../../common/monitoring/owner.js";

/**
 * Client allocation across mailbox seats (slice 1.6b).
 *
 * ⚠️ **Route ordering is load-bearing.** These paths sit under
 * `/organisations/:organisationId/customers/allocation`, which also matches
 * `CustomersController`'s `GET :customerId` — and that route's `ParseUUIDPipe`
 * would reject the literal "allocation" with a 400. This controller is
 * therefore registered BEFORE `CustomersController` in `customers.module.ts`,
 * and a test pins that order so a future tidy-up of the array cannot silently
 * break the screen.
 */
@Controller("organisations/:organisationId/customers/allocation")
@OwnedBy("platform")
export class AllocationController {
  constructor(private readonly allocationService: AllocationService) {}

  @Get()
  list(
    @CurrentAuthUser() authUser: AuthUser,
    @Param("organisationId", ParseUUIDPipe) organisationId: string,
  ): Promise<CustomerAllocationListDto> {
    return this.allocationService.list(authUser, organisationId);
  }

  @Put()
  allocate(
    @CurrentAuthUser() authUser: AuthUser,
    @Param("organisationId", ParseUUIDPipe) organisationId: string,
    @Body(new ZodValidationPipe(allocateClientsRequestSchema)) body: AllocateClientsRequest,
  ): Promise<AllocateClientsResultDto> {
    return this.allocationService.allocate(authUser, organisationId, body);
  }
}
