import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import type { Response } from "express";
import type { InvoiceDocumentDetail, InvoiceDocumentSummary } from "@eva/types";
import {
  confirmInvoiceDocumentRequestSchema,
  type ConfirmInvoiceDocumentRequest,
} from "@eva/validation";
import { ZodValidationPipe } from "../../../common/validation/zod-validation.pipe.js";
import {
  CurrentAuthUser,
  type AuthUser,
} from "../../../platform/authentication/current-auth-user.decorator.js";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  InvoiceDocumentsService,
  MAX_DOCUMENT_BYTES,
  type ConfirmInvoiceDocumentResponse,
  type UploadedPdfFile,
} from "./invoice-documents.service.js";

/**
 * PDF invoice extraction (Slice 1.4; plan §3). Uploads use memory storage
 * ONLY — the bytes are persisted to invoice_documents.content (plan §7.2),
 * never to disk. JSON responses never include the PDF; the /file endpoint
 * streams it for the review screen (and the 1.7 attachment source).
 */
@Controller("organisations/:organisationId/invoice-documents")
export class InvoiceDocumentsController {
  constructor(private readonly invoiceDocumentsService: InvoiceDocumentsService) {}

  @Post()
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: MAX_DOCUMENT_BYTES } }))
  upload(
    @CurrentAuthUser() authUser: AuthUser,
    @Param("organisationId", ParseUUIDPipe) organisationId: string,
    @UploadedFile() file: UploadedPdfFile | undefined,
  ): Promise<InvoiceDocumentDetail> {
    if (!file) throw new BadRequestException("A 'file' form field is required");
    return this.invoiceDocumentsService.upload(authUser, organisationId, file);
  }

  @Get()
  list(
    @CurrentAuthUser() authUser: AuthUser,
    @Param("organisationId", ParseUUIDPipe) organisationId: string,
  ): Promise<InvoiceDocumentSummary[]> {
    return this.invoiceDocumentsService.list(authUser, organisationId);
  }

  @Get(":documentId")
  getById(
    @CurrentAuthUser() authUser: AuthUser,
    @Param("organisationId", ParseUUIDPipe) organisationId: string,
    @Param("documentId", ParseUUIDPipe) documentId: string,
  ): Promise<InvoiceDocumentDetail> {
    return this.invoiceDocumentsService.getById(authUser, organisationId, documentId);
  }

  /** Streams the stored PDF (plan §3) so review can show source beside fields. */
  @Get(":documentId/file")
  async getFile(
    @CurrentAuthUser() authUser: AuthUser,
    @Param("organisationId", ParseUUIDPipe) organisationId: string,
    @Param("documentId", ParseUUIDPipe) documentId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const file = await this.invoiceDocumentsService.getFile(authUser, organisationId, documentId);
    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${file.filename.replaceAll('"', "")}"`,
      "Content-Length": file.content.length,
    });
    return new StreamableFile(file.content);
  }

  @Post(":documentId/extract")
  @HttpCode(200)
  extract(
    @CurrentAuthUser() authUser: AuthUser,
    @Param("organisationId", ParseUUIDPipe) organisationId: string,
    @Param("documentId", ParseUUIDPipe) documentId: string,
  ): Promise<InvoiceDocumentDetail> {
    return this.invoiceDocumentsService.extract(authUser, organisationId, documentId);
  }

  @Post(":documentId/confirm")
  @HttpCode(200)
  confirm(
    @CurrentAuthUser() authUser: AuthUser,
    @Param("organisationId", ParseUUIDPipe) organisationId: string,
    @Param("documentId", ParseUUIDPipe) documentId: string,
    @Body(new ZodValidationPipe(confirmInvoiceDocumentRequestSchema))
    body: ConfirmInvoiceDocumentRequest,
  ): Promise<ConfirmInvoiceDocumentResponse> {
    return this.invoiceDocumentsService.confirm(authUser, organisationId, documentId, body);
  }

  @Post(":documentId/cancel")
  @HttpCode(200)
  cancel(
    @CurrentAuthUser() authUser: AuthUser,
    @Param("organisationId", ParseUUIDPipe) organisationId: string,
    @Param("documentId", ParseUUIDPipe) documentId: string,
  ): Promise<InvoiceDocumentDetail> {
    return this.invoiceDocumentsService.cancel(authUser, organisationId, documentId);
  }
}
