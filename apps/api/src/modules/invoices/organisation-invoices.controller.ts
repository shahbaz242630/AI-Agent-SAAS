import { Controller, Get, Param, ParseUUIDPipe, Query } from "@nestjs/common";
import { CurrentAuthUser, type AuthUser } from "../authentication/current-auth-user.decorator.js";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { InvoicesService, type InvoiceBook } from "./invoices.service.js";

/**
 * The organisation's whole book (slice 1.6c, task 9 — the founder's one table).
 *
 * ⚠️ ITS OWN CONTROLLER BECAUSE THE ROUTE IS NOT NESTED UNDER A CUSTOMER, and
 * that is the entire point. Until now invoices were reachable only through a
 * client, so the first question a credit controller asks — "what is overdue
 * right now?" — could only be answered by opening clients one at a time.
 * `DATA-MODEL-REVIEW.md` §4 has said since Phase 1 that this should be Eva's
 * main screen.
 */
@Controller("organisations/:organisationId/invoices")
export class OrganisationInvoicesController {
  constructor(private readonly invoicesService: InvoicesService) {}

  /**
   * `invoices:read`, like every other invoice read — so an organisation without
   * the credit-controller module gets a 402 here too, and the gate order
   * 404 → 403 → 402 is unchanged.
   *
   * Everything is a query parameter and everything is optional: the screen
   * opens on the whole book and narrows from there.
   */
  @Get()
  list(
    @CurrentAuthUser() authUser: AuthUser,
    @Param("organisationId", ParseUUIDPipe) organisationId: string,
    /** A stored status, or a computed one (`overdue` / `due_today` / `due_soon`). */
    @Query("status") status?: string,
    @Query("currency") currency?: string,
    @Query("customerId") customerId?: string,
    /** Matches an invoice number or a client name. */
    @Query("search") search?: string,
    @Query("limit") limit?: string,
    @Query("offset") offset?: string,
  ): Promise<InvoiceBook> {
    return this.invoicesService.listForOrganisation(authUser, organisationId, {
      ...(status !== undefined ? { status } : {}),
      ...(currency !== undefined ? { currency } : {}),
      ...(customerId !== undefined ? { customerId } : {}),
      ...(search !== undefined ? { search } : {}),
      // Parsed here rather than by a pipe so a nonsense value falls back to the
      // default instead of 400-ing a screen that is only trying to page.
      ...(toPositiveInt(limit) !== null ? { limit: toPositiveInt(limit)! } : {}),
      ...(toPositiveInt(offset) !== null ? { offset: toPositiveInt(offset)! } : {}),
    });
  }
}

function toPositiveInt(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) return null;
  return parsed;
}
