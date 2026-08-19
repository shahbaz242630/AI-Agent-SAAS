import { Module } from "@nestjs/common";
import { UsersModule } from "../../../platform/users/users.module.js";
import { MailboxesModule } from "../../../capabilities/mailbox/mailboxes.module.js";
import { InternalSecretGuard } from "../../../platform/authentication/internal-secret.guard.js";
import { InternalRemindersController } from "./internal-reminders.controller.js";
import { RemindersController } from "./reminders.controller.js";
import { RemindersService } from "./reminders.service.js";
import { ReminderSenderService } from "./reminder-sender.service.js";

@Module({
  // MailboxesModule is imported for the 1.7 sender: it needs both
  // resolveSendingMailbox and ensureAccessToken (refresh-on-use) before a send.
  imports: [UsersModule, MailboxesModule],
  controllers: [RemindersController, InternalRemindersController],
  providers: [RemindersService, ReminderSenderService, InternalSecretGuard],
})
export class RemindersModule {}
