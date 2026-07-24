import { Module } from "@nestjs/common";
import { UsersModule } from "../users/users.module.js";
import { CustomersController } from "./customers.controller.js";
import { CustomersService } from "./customers.service.js";

@Module({
  imports: [UsersModule],
  controllers: [CustomersController],
  providers: [CustomersService],
})
export class CustomersModule {}
