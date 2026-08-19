import { Body, Controller, Get, Param, ParseUUIDPipe, Put } from "@nestjs/common";
import type { ModuleStatusDto } from "@eva/types";
import { moduleKeyParamSchema, setModuleSchema, type SetModuleInput } from "@eva/validation";
import { ZodValidationPipe } from "../../common/validation/zod-validation.pipe.js";
import { CurrentAuthUser, type AuthUser } from "../authentication/current-auth-user.decorator.js";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { EntitlementsService } from "./entitlements.service.js";

/**
 * Which products an organisation holds (Slice 1.6a). Cross-tenant access is
 * always 404, never 403 (BRD 15).
 *
 * Both routes are guarded by `core` permissions — see EntitlementsService for
 * why that is a requirement rather than an oversight.
 */
@Controller("organisations/:organisationId/modules")
export class EntitlementsController {
  constructor(private readonly entitlementsService: EntitlementsService) {}

  @Get()
  list(
    @CurrentAuthUser() authUser: AuthUser,
    @Param("organisationId", ParseUUIDPipe) organisationId: string,
  ): Promise<ModuleStatusDto[]> {
    return this.entitlementsService.list(authUser, organisationId);
  }

  /** Idempotent by design: PUT the state you want. Returns the whole list so
   *  the caller sees dependency knock-on effects without a second request. */
  @Put(":moduleKey")
  setModule(
    @CurrentAuthUser() authUser: AuthUser,
    @Param("organisationId", ParseUUIDPipe) organisationId: string,
    // Validated against the same closed list the database CHECK enforces, so
    // an unknown product is a clean 400 rather than a 500 from a constraint.
    @Param("moduleKey", new ZodValidationPipe(moduleKeyParamSchema)) moduleKey: string,
    @Body(new ZodValidationPipe(setModuleSchema)) body: SetModuleInput,
  ): Promise<ModuleStatusDto[]> {
    return this.entitlementsService.setModule(
      authUser,
      organisationId,
      moduleKey as Parameters<EntitlementsService["setModule"]>[2],
      body,
    );
  }
}
