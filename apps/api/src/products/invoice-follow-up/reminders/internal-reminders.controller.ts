import { Controller, HttpCode, Post, UseGuards } from "@nestjs/common";
import { Public } from "../../../platform/authentication/public.decorator.js";
import { InternalSecretGuard } from "../../../platform/authentication/internal-secret.guard.js";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { RemindersService, type ReconcileResult } from "./reminders.service.js";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { ReminderSenderService, type SendRemindersResult } from "./reminder-sender.service.js";

/**
 * Internal service-to-service endpoints (Slice 1.5, plan §7.8). @Public()
 * opts out of the Supabase JWT guard; the InternalSecretGuard (x-internal-
 * secret, constant-time compare) is the only authentication. Called by the
 * Trigger.dev daily sweep — never by the browser.
 */
@Controller("internal/reminders")
@UseGuards(InternalSecretGuard)
export class InternalRemindersController {
  constructor(
    private readonly remindersService: RemindersService,
    private readonly senderService: ReminderSenderService,
  ) {}

  @Public()
  @Post("reconcile")
  @HttpCode(200)
  reconcile(): Promise<ReconcileResult> {
    return this.remindersService.reconcile();
  }

  /**
   * Sends what reconcile has made `ready` (Slice 1.7).
   *
   * A SEPARATE endpoint from reconcile on purpose: scheduling is pure database
   * work and safe to repeat, whereas sending talks to Microsoft and puts words
   * in front of a customer. Keeping them apart means the schedule can be
   * re-run freely while the thing that sends stays a deliberate call — and a
   * sending outage never stops the queue being kept correct.
   */
  @Public()
  @Post("send")
  @HttpCode(200)
  send(): Promise<SendRemindersResult> {
    return this.senderService.sendDueReminders();
  }
}
