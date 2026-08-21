import { Module } from "@nestjs/common";
import { UsersModule } from "../users/users.module.js";
import { SuppressionController } from "./suppression.controller.js";
import { SuppressionService } from "./suppression.service.js";

@Module({
  imports: [UsersModule],
  controllers: [SuppressionController],
  providers: [SuppressionService],
})
export class SuppressionModule {}
