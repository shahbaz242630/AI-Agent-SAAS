import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import type { ImportDetail, ImportSummary } from "@eva/types";
import { confirmImportRequestSchema, type ConfirmImportRequest } from "@eva/validation";
import { ZodValidationPipe } from "../../common/validation/zod-validation.pipe.js";
import { CurrentAuthUser, type AuthUser } from "../authentication/current-auth-user.decorator.js";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { ImportsService, type UploadedImportFile } from "./imports.service.js";
import { MAX_UPLOAD_BYTES } from "./import-parser.js";

/**
 * CSV/Excel invoice import (Slice 1.3; plan §3). The upload uses memory
 * storage ONLY — the file is parsed and discarded, never written to disk
 * (BRD 16 data minimisation).
 */
@Controller("organisations/:organisationId/imports")
export class ImportsController {
  constructor(private readonly importsService: ImportsService) {}

  @Post()
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  upload(
    @CurrentAuthUser() authUser: AuthUser,
    @Param("organisationId", ParseUUIDPipe) organisationId: string,
    @UploadedFile() file: UploadedImportFile | undefined,
    @Body("mapping") mapping?: string,
  ): Promise<ImportDetail> {
    if (!file) throw new BadRequestException("A 'file' form field is required");
    return this.importsService.upload(authUser, organisationId, file, mapping);
  }

  @Get()
  list(
    @CurrentAuthUser() authUser: AuthUser,
    @Param("organisationId", ParseUUIDPipe) organisationId: string,
  ): Promise<ImportSummary[]> {
    return this.importsService.list(authUser, organisationId);
  }

  @Get(":importId")
  getById(
    @CurrentAuthUser() authUser: AuthUser,
    @Param("organisationId", ParseUUIDPipe) organisationId: string,
    @Param("importId", ParseUUIDPipe) importId: string,
  ): Promise<ImportDetail> {
    return this.importsService.getById(authUser, organisationId, importId);
  }

  @Post(":importId/confirm")
  @HttpCode(200)
  confirm(
    @CurrentAuthUser() authUser: AuthUser,
    @Param("organisationId", ParseUUIDPipe) organisationId: string,
    @Param("importId", ParseUUIDPipe) importId: string,
    // Optional per-row corrections (Slice 1.4 plan §7.9) — an empty/absent
    // body confirms the staged rows exactly as previewed.
    @Body(new ZodValidationPipe(confirmImportRequestSchema.optional())) body?: ConfirmImportRequest,
  ): Promise<ImportDetail> {
    return this.importsService.confirm(authUser, organisationId, importId, body);
  }

  @Post(":importId/cancel")
  @HttpCode(200)
  cancel(
    @CurrentAuthUser() authUser: AuthUser,
    @Param("organisationId", ParseUUIDPipe) organisationId: string,
    @Param("importId", ParseUUIDPipe) importId: string,
  ): Promise<ImportDetail> {
    return this.importsService.cancel(authUser, organisationId, importId);
  }
}
