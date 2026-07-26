import { Module } from "@nestjs/common";
import { UsersModule } from "../users/users.module.js";
import { InternalSecretGuard } from "../authentication/internal-secret.guard.js";
import { InternalRemindersController } from "./internal-reminders.controller.js";
import { RemindersController } from "./reminders.controller.js";
import { RemindersService } from "./reminders.service.js";

@Module({
  imports: [UsersModule],
  controllers: [RemindersController, InternalRemindersController],
  providers: [RemindersService, InternalSecretGuard],
})
export class RemindersModule {}
