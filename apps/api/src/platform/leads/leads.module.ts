import { Module } from "@nestjs/common";
import { UsersModule } from "../users/users.module.js";
import { LeadsController } from "./leads.controller.js";
import { LeadsService } from "./leads.service.js";

@Module({
  imports: [UsersModule],
  controllers: [LeadsController],
  providers: [LeadsService],
})
export class LeadsModule {}
