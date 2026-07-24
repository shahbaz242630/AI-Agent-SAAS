import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post } from "@nestjs/common";
import {
  createCustomerRequestSchema,
  updateCustomerRequestSchema,
  type CreateCustomerRequest,
  type UpdateCustomerRequest,
} from "@eva/validation";
import { ZodValidationPipe } from "../../common/validation/zod-validation.pipe.js";
import { CurrentAuthUser, type AuthUser } from "../authentication/current-auth-user.decorator.js";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { CustomersService, type CustomerSummary } from "./customers.service.js";

@Controller("organisations/:organisationId/customers")
export class CustomersController {
  constructor(private readonly customersService: CustomersService) {}

  @Get()
  list(
    @CurrentAuthUser() authUser: AuthUser,
    @Param("organisationId", ParseUUIDPipe) organisationId: string,
  ): Promise<CustomerSummary[]> {
    return this.customersService.list(authUser, organisationId);
  }

  @Post()
  create(
    @CurrentAuthUser() authUser: AuthUser,
    @Param("organisationId", ParseUUIDPipe) organisationId: string,
    @Body(new ZodValidationPipe(createCustomerRequestSchema)) body: CreateCustomerRequest,
  ): Promise<CustomerSummary> {
    return this.customersService.create(authUser, organisationId, body);
  }

  @Get(":customerId")
  getById(
    @CurrentAuthUser() authUser: AuthUser,
    @Param("organisationId", ParseUUIDPipe) organisationId: string,
    @Param("customerId", ParseUUIDPipe) customerId: string,
  ): Promise<CustomerSummary> {
    return this.customersService.getById(authUser, organisationId, customerId);
  }

  @Patch(":customerId")
  update(
    @CurrentAuthUser() authUser: AuthUser,
    @Param("organisationId", ParseUUIDPipe) organisationId: string,
    @Param("customerId", ParseUUIDPipe) customerId: string,
    @Body(new ZodValidationPipe(updateCustomerRequestSchema)) body: UpdateCustomerRequest,
  ): Promise<CustomerSummary> {
    return this.customersService.update(authUser, organisationId, customerId, body);
  }

  @Delete(":customerId")
  async remove(
    @CurrentAuthUser() authUser: AuthUser,
    @Param("organisationId", ParseUUIDPipe) organisationId: string,
    @Param("customerId", ParseUUIDPipe) customerId: string,
  ): Promise<void> {
    await this.customersService.remove(authUser, organisationId, customerId);
  }
}
