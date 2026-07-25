import { Module } from "@nestjs/common";
import { UsersModule } from "../users/users.module.js";
import { ImportsController } from "./imports.controller.js";
import { ImportsService } from "./imports.service.js";

@Module({
  imports: [UsersModule],
  controllers: [ImportsController],
  providers: [ImportsService],
})
export class ImportsModule {}
