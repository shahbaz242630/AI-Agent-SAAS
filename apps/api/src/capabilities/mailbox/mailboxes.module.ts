import { Module } from "@nestjs/common";
import { UsersModule } from "../../platform/users/users.module.js";
import { MICROSOFT_GRAPH_PROVIDER } from "./microsoft-graph/microsoft-graph-provider.js";
import { GraphMailProvider } from "./microsoft-graph/graph-mail-provider.js";
import { MICROSOFT_DISCOVERY } from "./microsoft-graph/microsoft-discovery.js";
import { MicrosoftDiscoveryService } from "./microsoft-graph/microsoft-discovery.service.js";
import { MailboxesController } from "./mailboxes.controller.js";
import { MailboxesService } from "./mailboxes.service.js";
import { MicrosoftOAuthController } from "./microsoft-oauth.controller.js";
import { GraphOutboundMail, OUTBOUND_MAIL } from "./outbound-mail.js";

@Module({
  imports: [UsersModule],
  controllers: [MailboxesController, MicrosoftOAuthController],
  providers: [
    MailboxesService,
    { provide: MICROSOFT_GRAPH_PROVIDER, useClass: GraphMailProvider },
    { provide: MICROSOFT_DISCOVERY, useClass: MicrosoftDiscoveryService },
    { provide: OUTBOUND_MAIL, useClass: GraphOutboundMail },
  ],
  /**
   * Exported for 1.7's sender:
   * - `MailboxesService` for `resolveSendingMailbox` (which mailbox chases this
   *   client, and whether any of them still works).
   * - `OUTBOUND_MAIL` for the delivery itself.
   *
   * ⚠️ The GRAPH PROVIDER IS DELIBERATELY NOT EXPORTED. Slice 1.5's structural
   * guard (plan §8 risk 7) requires sending to sit behind an adapter rather
   * than as direct provider calls inside the reminders module, and exporting
   * the provider is exactly how that rule would be quietly lost.
   */
  exports: [MailboxesService, OUTBOUND_MAIL],
})
export class MailboxesModule {}
