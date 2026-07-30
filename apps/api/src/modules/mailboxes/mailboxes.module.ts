import { Module } from "@nestjs/common";
import { UsersModule } from "../users/users.module.js";
import { MICROSOFT_GRAPH_PROVIDER } from "../integrations/microsoft-graph/microsoft-graph-provider.js";
import { GraphMailProvider } from "../integrations/microsoft-graph/graph-mail-provider.js";
import { MailboxesController } from "./mailboxes.controller.js";
import { MailboxesService } from "./mailboxes.service.js";
import { MicrosoftOAuthController } from "./microsoft-oauth.controller.js";

@Module({
  imports: [UsersModule],
  controllers: [MailboxesController, MicrosoftOAuthController],
  providers: [MailboxesService, { provide: MICROSOFT_GRAPH_PROVIDER, useClass: GraphMailProvider }],
  // Exported for 1.7: the reminder sender injects this to reach
  // ensureAccessToken (refresh-on-use) before each send.
  exports: [MailboxesService],
})
export class MailboxesModule {}
