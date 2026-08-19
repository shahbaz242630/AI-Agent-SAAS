import { Body, Controller, Get, Param, ParseUUIDPipe, Patch } from "@nestjs/common";
import type {
  ReminderActivityDto,
  ReminderSequenceDto,
  ReminderStepDto,
  ScheduledActionDto,
} from "@eva/types";
import { updateReminderStepSchema, type UpdateReminderStepInput } from "@eva/validation";
import { ZodValidationPipe } from "../../../common/validation/zod-validation.pipe.js";
import {
  CurrentAuthUser,
  type AuthUser,
} from "../../../platform/authentication/current-auth-user.decorator.js";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { RemindersService } from "./reminders.service.js";

/**
 * Reminder sequence configuration + per-invoice send-queue visibility
 * (Slice 1.5; plan §3). Cross-tenant access is always 404, never 403 (BRD 15).
 */
@Controller("organisations/:organisationId")
export class RemindersController {
  constructor(private readonly remindersService: RemindersService) {}

  @Get("reminder-sequence")
  getSequence(
    @CurrentAuthUser() authUser: AuthUser,
    @Param("organisationId", ParseUUIDPipe) organisationId: string,
  ): Promise<ReminderSequenceDto> {
    return this.remindersService.getSequence(authUser, organisationId);
  }

  @Patch("reminder-sequence/steps/:stepId")
  updateStep(
    @CurrentAuthUser() authUser: AuthUser,
    @Param("organisationId", ParseUUIDPipe) organisationId: string,
    @Param("stepId", ParseUUIDPipe) stepId: string,
    @Body(new ZodValidationPipe(updateReminderStepSchema)) body: UpdateReminderStepInput,
  ): Promise<ReminderStepDto> {
    return this.remindersService.updateStep(authUser, organisationId, stepId, body);
  }

  /** What Eva has actually done (Slice 1.7) — the counters and the history. */
  @Get("reminders/activity")
  getActivity(
    @CurrentAuthUser() authUser: AuthUser,
    @Param("organisationId", ParseUUIDPipe) organisationId: string,
  ): Promise<ReminderActivityDto> {
    return this.remindersService.getActivity(authUser, organisationId);
  }

  @Get("customers/:customerId/invoices/:invoiceId/scheduled-actions")
  listScheduledActions(
    @CurrentAuthUser() authUser: AuthUser,
    @Param("organisationId", ParseUUIDPipe) organisationId: string,
    @Param("customerId", ParseUUIDPipe) customerId: string,
    @Param("invoiceId", ParseUUIDPipe) invoiceId: string,
  ): Promise<ScheduledActionDto[]> {
    return this.remindersService.listScheduledActions(
      authUser,
      organisationId,
      customerId,
      invoiceId,
    );
  }
}
