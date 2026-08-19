import { Module } from "@nestjs/common";
import { UsersModule } from "../users/users.module.js";
import { EntitlementsController } from "./entitlements.controller.js";
import { EntitlementsService } from "./entitlements.service.js";

@Module({
  imports: [UsersModule],
  controllers: [EntitlementsController],
  providers: [EntitlementsService],
  exports: [EntitlementsService],
})
export class EntitlementsModule {}
