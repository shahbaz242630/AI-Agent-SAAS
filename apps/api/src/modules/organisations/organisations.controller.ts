import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Put } from "@nestjs/common";
import {
  createOrganisationRequestSchema,
  putRolePermissionsRequestSchema,
  updateMemberRoleRequestSchema,
  type CreateOrganisationRequest,
  type PutRolePermissionsRequest,
  type UpdateMemberRoleRequest,
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

@Controller("organisations")
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
