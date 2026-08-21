import { Module } from "@nestjs/common";
import { UsersModule } from "../../platform/users/users.module.js";
import { MICROSOFT_GRAPH_PROVIDER } from "./microsoft-graph/microsoft-graph-provider.js";
import { GraphMailProvider } from "./microsoft-graph/graph-mail-provider.js";
import { MICROSOFT_DISCOVERY } from "./microsoft-graph/microsoft-discovery.js";
import { MicrosoftDiscoveryService } from "./microsoft-graph/microsoft-discovery.service.js";
import { MailboxesController } from "./mailboxes.controller.js";
import { MailboxesService } from "./mailboxes.service.js";
import { MicrosoftOAuthController } from "./microsoft-oauth.controller.js";
import { RoutedOutboundMail, OUTBOUND_MAIL } from "./outbound-mail.js";
import { MAIL_PROVIDERS, type MailProviderRegistry } from "./mail-provider.js";
import { InboundAddressesController } from "./inbound/inbound-addresses.controller.js";
import { InboundAddressesService } from "./inbound/inbound-addresses.service.js";
import { InboundWebhookController } from "./inbound/inbound-webhook.controller.js";
import { InboundIntakeService } from "./inbound/inbound-intake.service.js";
import { RECEIVED_MAIL, ResendReceivedMail } from "./inbound/received-mail.js";
import { API_ENV } from "../../config/config.module.js";
import type { ApiEnv } from "../../config/env.js";

@Module({
  imports: [UsersModule],
  controllers: [
    MailboxesController,
    MicrosoftOAuthController,
    InboundAddressesController,
    InboundWebhookController,
  ],
  providers: [
    MailboxesService,
    InboundAddressesService,
    InboundIntakeService,
    /**
     * ⚠️ BUILT FROM ENV RATHER THAN `useClass`, so the API key is read once at
     * wiring time instead of being reached for on every fetch — and so a test
     * can replace the whole seam with a stub. Ruling 34 moves off Resend's
     * domain before the first sale; if the provider changes with it, this is
     * the one line that changes.
     */
    {
      provide: RECEIVED_MAIL,
      inject: [API_ENV],
      useFactory: (env: ApiEnv) => new ResendReceivedMail(env.RESEND_API_KEY),
    },
    { provide: MICROSOFT_GRAPH_PROVIDER, useClass: GraphMailProvider },
    { provide: MICROSOFT_DISCOVERY, useClass: MicrosoftDiscoveryService },
    { provide: OUTBOUND_MAIL, useClass: RoutedOutboundMail },
    /**
     * The provider registry (3.1b step 2).
     *
     * ⚠️ BUILT *FROM* `MICROSOFT_GRAPH_PROVIDER` RATHER THAN BESIDE IT, AND
     * THAT IS WHAT KEEPS THE EXISTING TESTS HONEST. Every mailbox spec
     * substitutes a stub with `overrideProvider(MICROSOFT_GRAPH_PROVIDER)`;
     * registering a separately-constructed adapter here would leave those
     * overrides pointing at nothing while the real Graph client ran underneath,
     * and the suite would go green against the live Microsoft endpoints.
     *
     * The map is the one place a new provider is added. Gmail is one entry.
     */
    {
      provide: MAIL_PROVIDERS,
      inject: [MICROSOFT_GRAPH_PROVIDER],
      useFactory: (microsoft: GraphMailProvider): MailProviderRegistry =>
        new Map([["microsoft", microsoft]]),
    },
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
