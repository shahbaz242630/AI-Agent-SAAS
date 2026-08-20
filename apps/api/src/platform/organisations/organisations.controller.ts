import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Put } from "@nestjs/common";
import {
  createOrganisationRequestSchema,
  putRolePermissionsRequestSchema,
  updateMemberRoleRequestSchema,
  updateOrganisationSettingsRequestSchema,
  type CreateOrganisationRequest,
  type PutRolePermissionsRequest,
  type UpdateMemberRoleRequest,
  type UpdateOrganisationSettingsRequest,
} from "@eva/validation";
import { ZodValidationPipe } from "../../common/validation/zod-validation.pipe.js";
import { CurrentAuthUser, type AuthUser } from "../authentication/current-auth-user.decorator.js";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  OrganisationsService,
  type MemberSummary,
  type OrganisationSummary,
  type RolePermissionsView,
} from "./organisations.service.js";
import { OwnedBy } from "../../common/monitoring/owner.js";

@Controller("organisations")
@OwnedBy("platform")
export class OrganisationsController {
  constructor(private readonly organisationsService: OrganisationsService) {}

  @Get()
  listMine(@CurrentAuthUser() authUser: AuthUser): Promise<OrganisationSummary[]> {
    return this.organisationsService.listMine(authUser);
  }

  @Post()
  create(
    @CurrentAuthUser() authUser: AuthUser,
    @Body(new ZodValidationPipe(createOrganisationRequestSchema)) body: CreateOrganisationRequest,
  ): Promise<OrganisationSummary> {
    // Tenant resolution rule (BRD 15): the org id is generated server-side —
    // never taken from the request body.
    return this.organisationsService.create(authUser, body.name);
  }

  @Get(":id/members")
  listMembers(
    @CurrentAuthUser() authUser: AuthUser,
    @Param("id", ParseUUIDPipe) organisationId: string,
  ): Promise<MemberSummary[]> {
    return this.organisationsService.listMembers(authUser, organisationId);
  }

  @Patch(":id/members/:userId")
  changeMemberRole(
    @CurrentAuthUser() authUser: AuthUser,
    @Param("id", ParseUUIDPipe) organisationId: string,
    @Param("userId", ParseUUIDPipe) targetUserId: string,
    @Body(new ZodValidationPipe(updateMemberRoleRequestSchema)) body: UpdateMemberRoleRequest,
  ): Promise<MemberSummary> {
    return this.organisationsService.changeMemberRole(
      authUser,
      organisationId,
      targetUserId,
      body.roleKey,
    );
  }

  /**
   * Change the organisation's settings (slice 1.6c, task 13).
   *
   * PATCH rather than PUT: `organisation_settings` also holds the timezone,
   * locale, business hours and payment instructions, and a PUT would invite a
   * caller to send a partial body and silently blank the rest.
   *
   * There is deliberately no GET beside it — `defaultCurrency` rides on the
   * organisation summary every screen already fetches, so a form never waits on
   * a second round trip to know which option to pre-select.
   */
  @Patch(":id/settings")
  updateSettings(
    @CurrentAuthUser() authUser: AuthUser,
    @Param("id", ParseUUIDPipe) organisationId: string,
    @Body(new ZodValidationPipe(updateOrganisationSettingsRequestSchema))
    body: UpdateOrganisationSettingsRequest,
  ): Promise<OrganisationSummary> {
    return this.organisationsService.updateSettings(authUser, organisationId, body);
  }

  @Get(":id/permissions")
  getRolePermissions(
    @CurrentAuthUser() authUser: AuthUser,
    @Param("id", ParseUUIDPipe) organisationId: string,
  ): Promise<RolePermissionsView> {
    return this.organisationsService.getRolePermissions(authUser, organisationId);
  }

  @Put(":id/permissions")
  putRolePermissions(
    @CurrentAuthUser() authUser: AuthUser,
    @Param("id", ParseUUIDPipe) organisationId: string,
    @Body(new ZodValidationPipe(putRolePermissionsRequestSchema)) body: PutRolePermissionsRequest,
  ): Promise<RolePermissionsView> {
    return this.organisationsService.putRolePermissions(authUser, organisationId, body);
  }
}
