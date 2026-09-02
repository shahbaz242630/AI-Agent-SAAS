import { Module } from "@nestjs/common";
import { UsersModule } from "../../../platform/users/users.module.js";
import { LeadReplyTemplatesController } from "./lead-reply-templates.controller.js";
import { LeadReplyTemplatesService } from "./lead-reply-templates.service.js";

/**
 * The lead product's first module of its own (slice 3.1c-1).
 *
 * No `MailboxesModule` yet: this slice stores words, it does not send them.
 * That import arrives with 3.1c-3, alongside `resolveSendingMailbox`.
 */
@Module({
  imports: [UsersModule],
  controllers: [LeadReplyTemplatesController],
  providers: [LeadReplyTemplatesService],
  exports: [LeadReplyTemplatesService],
})
export class LeadReplyTemplatesModule {}
