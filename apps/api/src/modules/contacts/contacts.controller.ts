import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post } from "@nestjs/common";
import {
  createContactRequestSchema,
  updateContactRequestSchema,
  type CreateContactRequest,
  type UpdateContactRequest,
} from "@eva/validation";
import { ZodValidationPipe } from "../../common/validation/zod-validation.pipe.js";
import { CurrentAuthUser, type AuthUser } from "../authentication/current-auth-user.decorator.js";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { ContactsService, type ContactSummary } from "./contacts.service.js";

@Controller("organisations/:organisationId/customers/:customerId/contacts")
export class ContactsController {
  constructor(private readonly contactsService: ContactsService) {}

  @Get()
  list(
    @CurrentAuthUser() authUser: AuthUser,
    @Param("organisationId", ParseUUIDPipe) organisationId: string,
    @Param("customerId", ParseUUIDPipe) customerId: string,
  ): Promise<ContactSummary[]> {
    return this.contactsService.list(authUser, organisationId, customerId);
  }

  @Post()
  create(
    @CurrentAuthUser() authUser: AuthUser,
    @Param("organisationId", ParseUUIDPipe) organisationId: string,
    @Param("customerId", ParseUUIDPipe) customerId: string,
    @Body(new ZodValidationPipe(createContactRequestSchema)) body: CreateContactRequest,
  ): Promise<ContactSummary> {
    return this.contactsService.create(authUser, organisationId, customerId, body);
  }

  @Get(":contactId")
  getById(
    @CurrentAuthUser() authUser: AuthUser,
    @Param("organisationId", ParseUUIDPipe) organisationId: string,
    @Param("customerId", ParseUUIDPipe) customerId: string,
    @Param("contactId", ParseUUIDPipe) contactId: string,
  ): Promise<ContactSummary> {
    return this.contactsService.getById(authUser, organisationId, customerId, contactId);
  }

  @Patch(":contactId")
  update(
    @CurrentAuthUser() authUser: AuthUser,
    @Param("organisationId", ParseUUIDPipe) organisationId: string,
    @Param("customerId", ParseUUIDPipe) customerId: string,
    @Param("contactId", ParseUUIDPipe) contactId: string,
    @Body(new ZodValidationPipe(updateContactRequestSchema)) body: UpdateContactRequest,
  ): Promise<ContactSummary> {
    return this.contactsService.update(authUser, organisationId, customerId, contactId, body);
  }

  @Delete(":contactId")
  async remove(
    @CurrentAuthUser() authUser: AuthUser,
    @Param("organisationId", ParseUUIDPipe) organisationId: string,
    @Param("customerId", ParseUUIDPipe) customerId: string,
    @Param("contactId", ParseUUIDPipe) contactId: string,
  ): Promise<void> {
    await this.contactsService.remove(authUser, organisationId, customerId, contactId);
  }
}
