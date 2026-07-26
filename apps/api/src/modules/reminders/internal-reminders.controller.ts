import { Controller, HttpCode, Post, UseGuards } from "@nestjs/common";
import { Public } from "../authentication/public.decorator.js";
import { InternalSecretGuard } from "../authentication/internal-secret.guard.js";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { RemindersService, type ReconcileResult } from "./reminders.service.js";

/**
 * Internal service-to-service endpoints (Slice 1.5, plan §7.8). @Public()
 * opts out of the Supabase JWT guard; the InternalSecretGuard (x-internal-
 * secret, constant-time compare) is the only authentication. Called by the
 * Trigger.dev daily sweep — never by the browser.
 */
@Controller("internal/reminders")
@UseGuards(InternalSecretGuard)
export class InternalRemindersController {
  constructor(private readonly remindersService: RemindersService) {}

  @Public()
  @Post("reconcile")
  @HttpCode(200)
  reconcile(): Promise<ReconcileResult> {
    return this.remindersService.reconcile();
  }
}
