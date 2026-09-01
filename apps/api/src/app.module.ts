import { Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { LoggerModule, PinoLogger } from "nestjs-pino";
import { ApiConfigModule } from "./config/config.module.js";
import { DatabaseModule } from "./common/database/database.module.js";
import { AuthenticationModule } from "./platform/authentication/authentication.module.js";
import { ContactsModule } from "./platform/contacts/contacts.module.js";
import { CustomersModule } from "./platform/customers/customers.module.js";
import { EntitlementsModule } from "./platform/entitlements/entitlements.module.js";
import { LeadsModule } from "./platform/leads/leads.module.js";
import { SuppressionModule } from "./platform/suppression/suppression.module.js";
import { ImportsModule } from "./products/invoice-follow-up/imports/imports.module.js";
import { InvoiceDocumentsModule } from "./products/invoice-follow-up/invoice-documents/invoice-documents.module.js";
import { InvoicesModule } from "./products/invoice-follow-up/invoices/invoices.module.js";
import { LeadReplyTemplatesModule } from "./products/lead-follow-up-email/templates/lead-reply-templates.module.js";
import { LeadReplyModule } from "./products/lead-follow-up-email/reply/lead-reply.module.js";
import { NewLeadHandlersModule } from "./products/new-lead-handlers.module.js";
import { MailboxesModule } from "./capabilities/mailbox/mailboxes.module.js";
import { MonitoringModule } from "./platform/monitoring/monitoring.module.js";
import { OrganisationsModule } from "./platform/organisations/organisations.module.js";
import { RemindersModule } from "./products/invoice-follow-up/reminders/reminders.module.js";
import { UsersModule } from "./platform/users/users.module.js";
import { LOG_REDACT_PATHS, serializeRequest } from "./common/logging/log-redaction.js";
import { GlobalExceptionFilter } from "./common/filters/global-exception.filter.js";
import { ERROR_REPORTER } from "./common/monitoring/error-reporter.js";
import { RequestOwnerGuard } from "./common/monitoring/request-owner.guard.js";
import { FAULT_LOG, type FaultLog } from "./common/monitoring/fault-log.js";
import { sentryErrorReporter } from "./common/monitoring/sentry.js";

@Module({
  imports: [
    ApiConfigModule,
    DatabaseModule,
    // Global rate limiting (BRD 13): 100 requests/minute per client, generous
    // enough for legit UI bursts; burst behaviour documented in rate-limit.spec.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),
    AuthenticationModule,
    UsersModule,
    OrganisationsModule,
    CustomersModule,
    ContactsModule,
    InvoicesModule,
    ImportsModule,
    InvoiceDocumentsModule,
    RemindersModule,
    MailboxesModule,
    EntitlementsModule,
    LeadsModule,
    LeadReplyTemplatesModule,
    LeadReplyModule,
    /**
     * ⚠️ WIRES THE MAILBOX CAPABILITY'S NEW-LEAD PORT TO THE PRODUCTS THAT
     * LISTEN. Neither side may import the other; this is the composition
     * root that knows both. See the file for why it is `@Global()` — the
     * first version was a dynamic module and silently sent nothing.
     */
    NewLeadHandlersModule,
    SuppressionModule,
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? "info",
        // Correlation IDs: honour an inbound header, else generate (BRD 14).
        genReqId: (req, res) => {
          const header = req.headers["x-correlation-id"];
          const id = typeof header === "string" && header.length > 0 ? header : crypto.randomUUID();
          res.setHeader("x-correlation-id", id);
          return id;
        },
        // Never log credentials or personal contact details (BRD 14 — no tokens in logs).
        redact: LOG_REDACT_PATHS,
        // The OAuth callback URL carries the authorization code + state
        // (Slice 1.6, BRD 14). Two layers: the serializer strips the query
        // from EVERY line the request emits (nestjs-pino attaches `req` to all
        // of them), and autoLogging skips the completion line entirely.
        serializers: { req: serializeRequest },
        autoLogging: {
          ignore: (req) => (req.url ?? "").startsWith("/integrations/microsoft/callback"),
        },
        ...(process.env.NODE_ENV === "development" ? { transport: { target: "pino-pretty" } } : {}),
      },
      /**
       * ⚠️ THIS IS WHAT PUTS `product` ON THE COMPLETION LINE, and that line is
       * the per-product metric. Without it, `PinoLogger.assign` reaches every
       * line the request emits EXCEPT pino-http's own `request completed` —
       * the only one carrying `responseTime` and `statusCode`. Requests per
       * product, error rate per product and latency per product are all that
       * line, grouped; leaving it untagged would mean building a metrics
       * service to recover what we were already writing.
       */
      assignResponse: true,
    }),
    MonitoringModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
    /**
     * ⚠️ FIRST, AND THE ORDER IS THE FEATURE. Global guards run in the order
     * they are registered here, so this one tags the request before the rate
     * limiter can reject it and before authentication can refuse it — which
     * means a 429 or a 401 still says which product the customer was trying to
     * use. Registered after this line, it would only ever label requests that
     * had already succeeded at getting in.
     */
    { provide: APP_GUARD, useClass: RequestOwnerGuard },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: ERROR_REPORTER, useValue: sentryErrorReporter },
    /**
     * The fault log, on the same pino stream as every other line (so the entry
     * sits directly beside the request that produced it in Railway) and at
     * `error` level (so `--level error` finds it).
     *
     * ⚠️ `request faulted` IS THE STRING TO GREP. It is deliberately not
     * "request errored" — that one belongs to pino-http, is emitted for every
     * 500 with no cause attached, and on 2026-08-11 was the only thing in the
     * log for two hours of a dead dashboard. The two must not read alike.
     */
    {
      provide: FAULT_LOG,
      inject: [PinoLogger],
      useFactory: (logger: PinoLogger): FaultLog => ({
        recordFault: (entry) => {
          logger.error(entry, "request faulted");
        },
      }),
    },
  ],
})
export class AppModule {}
