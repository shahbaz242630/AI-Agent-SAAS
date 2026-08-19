import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import {
  createInvoiceRequestSchema,
  recordPaymentRequestSchema,
  updateInvoiceRequestSchema,
  type CreateInvoiceRequest,
  type RecordPaymentRequest,
  type UpdateInvoiceRequest,
} from "@eva/validation";
import { ZodValidationPipe } from "../../../common/validation/zod-validation.pipe.js";
import {
  CurrentAuthUser,
  type AuthUser,
} from "../../../platform/authentication/current-auth-user.decorator.js";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { InvoicesService, type InvoiceSummary } from "./invoices.service.js";

@Controller("organisations/:organisationId/customers/:customerId/invoices")
export class InvoicesController {
  constructor(private readonly invoicesService: InvoicesService) {}

  @Get()
  list(
    @CurrentAuthUser() authUser: AuthUser,
    @Param("organisationId", ParseUUIDPipe) organisationId: string,
    @Param("customerId", ParseUUIDPipe) customerId: string,
    @Query("status") status?: string,
    @Query("contactId") contactId?: string,
  ): Promise<InvoiceSummary[]> {
    return this.invoicesService.list(authUser, organisationId, customerId, {
      ...(status !== undefined ? { status } : {}),
      ...(contactId !== undefined ? { contactId } : {}),
    });
  }

  @Post()
  create(
    @CurrentAuthUser() authUser: AuthUser,
    @Param("organisationId", ParseUUIDPipe) organisationId: string,
    @Param("customerId", ParseUUIDPipe) customerId: string,
    @Body(new ZodValidationPipe(createInvoiceRequestSchema)) body: CreateInvoiceRequest,
  ): Promise<InvoiceSummary> {
    return this.invoicesService.create(authUser, organisationId, customerId, body);
  }

  @Get(":invoiceId")
  getById(
    @CurrentAuthUser() authUser: AuthUser,
    @Param("organisationId", ParseUUIDPipe) organisationId: string,
    @Param("customerId", ParseUUIDPipe) customerId: string,
    @Param("invoiceId", ParseUUIDPipe) invoiceId: string,
  ): Promise<InvoiceSummary> {
    return this.invoicesService.getById(authUser, organisationId, customerId, invoiceId);
  }

  @Patch(":invoiceId")
  update(
    @CurrentAuthUser() authUser: AuthUser,
    @Param("organisationId", ParseUUIDPipe) organisationId: string,
    @Param("customerId", ParseUUIDPipe) customerId: string,
    @Param("invoiceId", ParseUUIDPipe) invoiceId: string,
    @Body(new ZodValidationPipe(updateInvoiceRequestSchema)) body: UpdateInvoiceRequest,
  ): Promise<InvoiceSummary> {
    return this.invoicesService.update(authUser, organisationId, customerId, invoiceId, body);
  }

  @Delete(":invoiceId")
  async remove(
    @CurrentAuthUser() authUser: AuthUser,
    @Param("organisationId", ParseUUIDPipe) organisationId: string,
    @Param("customerId", ParseUUIDPipe) customerId: string,
    @Param("invoiceId", ParseUUIDPipe) invoiceId: string,
  ): Promise<void> {
    await this.invoicesService.remove(authUser, organisationId, customerId, invoiceId);
  }

  @Post(":invoiceId/activate")
  @HttpCode(200)
  activate(
    @CurrentAuthUser() authUser: AuthUser,
    @Param("organisationId", ParseUUIDPipe) organisationId: string,
    @Param("customerId", ParseUUIDPipe) customerId: string,
    @Param("invoiceId", ParseUUIDPipe) invoiceId: string,
  ): Promise<InvoiceSummary> {
    return this.invoicesService.transition(
      authUser,
      organisationId,
      customerId,
      invoiceId,
      "activate",
    );
  }

  @Post(":invoiceId/pause")
  @HttpCode(200)
  pause(
    @CurrentAuthUser() authUser: AuthUser,
    @Param("organisationId", ParseUUIDPipe) organisationId: string,
    @Param("customerId", ParseUUIDPipe) customerId: string,
    @Param("invoiceId", ParseUUIDPipe) invoiceId: string,
  ): Promise<InvoiceSummary> {
    return this.invoicesService.transition(
      authUser,
      organisationId,
      customerId,
      invoiceId,
      "pause",
    );
  }

  @Post(":invoiceId/resume")
  @HttpCode(200)
  resume(
    @CurrentAuthUser() authUser: AuthUser,
    @Param("organisationId", ParseUUIDPipe) organisationId: string,
    @Param("customerId", ParseUUIDPipe) customerId: string,
    @Param("invoiceId", ParseUUIDPipe) invoiceId: string,
  ): Promise<InvoiceSummary> {
    return this.invoicesService.transition(
      authUser,
      organisationId,
      customerId,
      invoiceId,
      "resume",
    );
  }

  /**
   * Record money received (slice 1.6c, task 5).
   *
   * ⚠️ ITS OWN ENDPOINT, NOT A PATCH. `PATCH` is draft-only and cannot touch
   * status; a payment applies to an ISSUED invoice and moves its status through
   * the state machine. And it is a payment rather than a "mark as paid": the
   * status follows the money, so nobody can declare an invoice settled without
   * recording what settled it.
   *
   * 200, not 201: it changes an invoice and returns that invoice. Nothing
   * addressable is created — individual payments are not stored separately, only
   * the running total (plan §4 task 5).
   */
  @Post(":invoiceId/payments")
  @HttpCode(200)
  recordPayment(
    @CurrentAuthUser() authUser: AuthUser,
    @Param("organisationId", ParseUUIDPipe) organisationId: string,
    @Param("customerId", ParseUUIDPipe) customerId: string,
    @Param("invoiceId", ParseUUIDPipe) invoiceId: string,
    @Body(new ZodValidationPipe(recordPaymentRequestSchema)) body: RecordPaymentRequest,
  ): Promise<InvoiceSummary> {
    return this.invoicesService.recordPayment(
      authUser,
      organisationId,
      customerId,
      invoiceId,
      body,
    );
  }

  @Post(":invoiceId/cancel")
  @HttpCode(200)
  cancel(
    @CurrentAuthUser() authUser: AuthUser,
    @Param("organisationId", ParseUUIDPipe) organisationId: string,
    @Param("customerId", ParseUUIDPipe) customerId: string,
    @Param("invoiceId", ParseUUIDPipe) invoiceId: string,
  ): Promise<InvoiceSummary> {
    return this.invoicesService.transition(
      authUser,
      organisationId,
      customerId,
      invoiceId,
      "cancel",
    );
  }
}
