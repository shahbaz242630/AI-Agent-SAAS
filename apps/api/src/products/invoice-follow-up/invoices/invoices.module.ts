import { Module } from "@nestjs/common";
import { UsersModule } from "../../../platform/users/users.module.js";
import { InvoicesController } from "./invoices.controller.js";
import { InvoicesService } from "./invoices.service.js";
import { OrganisationInvoicesController } from "./organisation-invoices.controller.js";

@Module({
  imports: [UsersModule],
  /**
   * ⚠️ ORDER MATTERS. `OrganisationInvoicesController` is
   * `organisations/:organisationId/invoices`; `InvoicesController` is
   * `organisations/:organisationId/customers/:customerId/invoices`. They do not
   * overlap — but if a shorter path is ever added that could shadow a longer
   * one, Nest matches in registration order, so keep the specific one first.
   */
  controllers: [InvoicesController, OrganisationInvoicesController],
  providers: [InvoicesService],
})
export class InvoicesModule {}
