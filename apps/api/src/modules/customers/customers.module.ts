import { Module } from "@nestjs/common";
import { UsersModule } from "../users/users.module.js";
import { AllocationController } from "./allocation.controller.js";
import { AllocationService } from "./allocation.service.js";
import { CustomersController } from "./customers.controller.js";
import { CustomersService } from "./customers.service.js";

@Module({
  imports: [UsersModule],
  /**
   * ⚠️ ORDER MATTERS. `AllocationController` mounts
   * `/organisations/:organisationId/customers/allocation`, which also matches
   * `CustomersController`'s `GET :customerId`. Nest registers controllers in
   * array order, so allocation must come FIRST or the literal "allocation" is
   * parsed as a customer id and rejected by `ParseUUIDPipe` with a 400.
   * `allocation.spec.ts` pins this — flipping the array fails five tests,
   * including the entire allocation view.
   */
  controllers: [AllocationController, CustomersController],
  providers: [AllocationService, CustomersService],
})
export class CustomersModule {}
