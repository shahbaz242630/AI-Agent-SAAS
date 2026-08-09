import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma, withTenant } from "@eva/database";
import {
  CHASED_INVOICE_STATUSES,
  INVOICE_COMPUTED_STATUSES,
  INVOICE_STORED_STATUSES,
  minorUnitsToNumber,
  outstandingBalance,
  type InvoiceDisplayStatus,
} from "@eva/types";
import type {
  AddBookRowRequest,
  CreateInvoiceRequest,
  RecordPaymentRequest,
  UpdateInvoiceRequest,
} from "@eva/validation";
import {
  createCustomerFromCanonical,
  listLiveCustomers,
  resolveCustomer,
  resolveOrCreateContact,
  type CanonicalRow,
} from "../../common/ledger/ledger.js";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PrismaService } from "../../common/database/prisma.service.js";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { UsersService } from "../users/users.service.js";
import { requirePermission, type TenantTx } from "../../common/permissions/permissions.js";
import { writeAuditLog } from "../../common/audit/audit-log.js";
import type { AuthUser } from "../authentication/current-auth-user.decorator.js";
import {
  ageingBucketFor,
  computedStatusDueDateRange,
  deriveDisplayStatus,
  todayInTimezone,
} from "./invoice-status.js";
import {
  transitionInvoiceStatus,
  type InvoiceAction,
  type InvoiceLifecycleAction,
} from "./invoice-state-machine.js";
import { resolveChaseBlockedReason, type ChaseBlockedReason } from "./chase-blockers.js";
import { normaliseSuppressionValue } from "../../common/suppression/suppression.js";
import {
  cancelInvoiceReminders,
  recomputeInvoiceReminders,
  scheduleInvoiceReminders,
} from "../reminders/reminder-actions.js";

export interface InvoiceSummary {
  id: string;
  customerId: string;
  contactId: string | null;
  invoiceNumber: string;
  amountMinorUnits: number;
  /** Paid so far (migration 0019). 0 until a payment is recorded. */
  amountPaidMinorUnits: number;
  /**
   * What Eva actually chases — `amount - paid`, clamped at zero.
   *
   * DERIVED on every read, never stored: a third number can disagree with the
   * other two. Sent because every caller needs it and none of them should be
   * doing money arithmetic of their own.
   */
  outstandingMinorUnits: number;
  currency: string;
  issueDate: Date;
  dueDate: Date;
  /**
   * One line of context ("Bathroom renovation, final"), added by migration 0019
   * and published here for slice 1.6c's invoice list.
   *
   * A list of bare numbers makes the reader open every row to find the one they
   * mean, and a chaser built from an amount alone is weak — "your invoice for
   * 4,000" invites "which one?". Deliberately NOT line items: those are
   * permanently out of scope (DATA-MODEL-REVIEW §5).
   */
  description: string | null;
  /** The stored status (one of the nine — plan §7.1). */
  status: string;
  /** Stored status, or due_soon/due_today/overdue derived for Active rows. */
  displayStatus: InvoiceDisplayStatus;
  /**
   * Why Eva could not email a reminder for this invoice, SETTING ITS STATUS
   * ASIDE — null when nothing is in the way (slice 1.6c).
   *
   * Published because the screens had no way to know. They could see a missing
   * recipient and nothing else, so an invoice whose contact had no email
   * address, or who had asked not to be emailed, or whose organisation had no
   * working mailbox, was scheduled nothing while the screen said "Eva will
   * chase it". An invoice is actually being chased when it is Active AND this
   * is null; the status is left out precisely so the Start chasing button can
   * ask what would happen AFTER the status changes.
   */
  chaseBlockedReason: ChaseBlockedReason | null;
  /**
   * When money was last received against this invoice (migration 0019), or null
   * if none has been. Written for the first time by slice 1.6c's payments
   * endpoint — the column existed with no writer, which is why `DATA-MODEL-
   * REVIEW.md` §4's "average days to get paid" could not be computed at all.
   */
  lastPaymentAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** The database row, which carries more than the response does. */
type InvoiceRow = {
  id: string;
  customerId: string;
  contactId: string | null;
  invoiceNumber: string;
  amountMinorUnits: bigint;
  amountPaidMinorUnits: bigint;
  currency: string;
  issueDate: Date;
  dueDate: Date;
  description: string | null;
  status: string;
  lastPaymentAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  /** Loaded with the invoice so the chase blockers cost no extra round trip. */
  contact?: { deletedAt: Date | null; email: string | null } | null;
};

/**
 * Every read of an invoice loads its contact — see `chaseBlockersFor`.
 *
 * `name` and `phone` are here for the org-wide book, which shows who Eva writes
 * to beside each invoice. They are selected, not published: `toSummary` lists
 * its fields explicitly, so loading a column is still not the same act as
 * sending it to a browser.
 */
const WITH_CONTACT = {
  contact: { select: { id: true, name: true, email: true, phone: true, deletedAt: true } },
} as const;

/** Ageing by due date — `DATA-MODEL-REVIEW.md` §4's buckets, derived, never stored. */
export type AgeingBucket = "current" | "days_1_15" | "days_16_30" | "days_31_45" | "days_over_45";

/**
 * One row of the org-wide book (slice 1.6c, task 9 — the founder's one table).
 *
 * Carries the CLIENT beside the invoice because that is how the job is done:
 * a credit controller reads "who owes me what, and is anyone chasing it", not
 * an invoice in isolation. Client details repeat down the rows, exactly like
 * the spreadsheet this replaces.
 */
export interface InvoiceBookRow extends InvoiceSummary {
  customer: { id: string; name: string; reference: string | null };
  /** The reminder recipient — the address Eva actually writes to, or null. */
  contact: { id: string; name: string; email: string | null; phone: string | null } | null;
  /**
   * The org-local day of the most recent reminder actually SENT, or null.
   *
   * ⚠️ NULL FOR EVERYTHING UNTIL SLICE 1.7 EXISTS. Nothing sends yet, so no
   * `scheduled_actions` row ever reaches `sent`. The column is built now so it
   * fills in the day sending ships rather than being retrofitted then — but a
   * screen must not present an empty value here as "never chased".
   */
  lastChasedOn: Date | null;
  /** The org-local day of the next queued reminder. Real today. */
  nextChaseOn: Date | null;
  /** Which ageing bucket the due date falls into, in the ORG's timezone. */
  ageingBucket: AgeingBucket;
}

/** What the book returns: the page, how many matched, and the money by currency. */
export interface InvoiceBook {
  rows: InvoiceBookRow[];
  /** Rows matching the filters, before paging. */
  totalCount: number;
  /**
   * Every currency the organisation is CHASING money in, each with its own
   * total.
   *
   * ⚠️ NEVER SUMMED ACROSS CURRENCIES (trap 3b) — adding AED to GBP produces a
   * confident wrong number, which is worse than no number. The screen shows one
   * at a time and uses this list to say which others exist, so choosing GBP
   * still tells you there is money in AED.
   *
   * Counts CHASED invoices only. A cancelled invoice's arithmetic balance is
   * not money anybody is collecting, and putting it in a total is how "what am
   * I owed" becomes wrong.
   */
  chasedByCurrency: CurrencyTotal[];
  /**
   * The money the REQUEST'S FILTERS actually selected, per currency.
   *
   * ⚠️ THIS IS THE ONLY TOTAL THAT MAY BE PRINTED UNDER A FILTERED HEADING, and
   * the distinction is the whole reason it exists. `chasedByCurrency` is
   * computed from the organisation id alone, so `?status=overdue` returned
   * WHOLE-BOOK money — put that under "overdue" and the screen states, in
   * money, something untrue. The home screen could therefore only ever say how
   * MANY invoices were overdue, and the book screen showed a total that
   * disagreed with the list printed directly beneath it.
   *
   * ⚠️ IT IS NOT A REPLACEMENT FOR `chasedByCurrency` AND MUST NOT BECOME ONE.
   * The book screen's currency picker is built from the unfiltered list, which
   * is what lets a customer looking at GBP still be told there is money in AED.
   * Filtering that list would collapse the picker to the currency already
   * chosen and hide the rest of the book — the exact failure the picker was
   * built to prevent.
   *
   * ⚠️ UNLIKE `chasedByCurrency` THIS TOTALS WHATEVER WAS ASKED FOR, including
   * states nobody is collecting: `?status=cancelled` returns cancelled money.
   * That is honest under the heading the caller chose and wrong under any
   * other, so it is never "what you are owed" unless the filter says so.
   */
  matchedByCurrency: CurrencyTotal[];
}

/** One currency's slice of a book — never added to another's (trap 3b). */
export interface CurrencyTotal {
  currency: string;
  invoiceCount: number;
  outstandingMinorUnits: number;
}

const DEFAULT_TIMEZONE = "Europe/London";

/**
 * The most rows one request of the book can return.
 *
 * Bounded because this endpoint reads a whole organisation rather than one
 * client, and an unbounded read is a query that works on the demo book and
 * takes a server down on a real one. The screen pages; the cap is what stops a
 * hand-written `?limit=100000` from mattering.
 */
const MAX_BOOK_PAGE = 200;

/** A `Date` at UTC midnight as the calendar day it represents. */
function isoDay(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/**
 * A computed status's due-date range, in SQL.
 *
 * `due_date` is a DATE column and a JS `Date` reaches the driver as a
 * timestamp, so the comparison would depend on the SERVER's timezone —
 * an off-by-one on the boundary day that nobody would notice until a month end.
 * Passing the calendar day and casting it removes the question.
 *
 * ⚠️ NO TEST PROVES THIS, AND THAT IS STATED RATHER THAN IMPLIED. Passing the
 * `Date` straight through was tried on 2026-08-09 and all 114 tests stayed
 * green, because our local Postgres and Supabase both run `TimeZone = UTC`,
 * where the two forms agree. It is kept because it is correct on a server that
 * does not, and because it says what it means — but it is a belt, not a
 * measurement, and a future reader should not mistake it for one.
 */
function dueDateCondition(range: Exclude<BookDueDateRange, null>): Prisma.Sql {
  if ("lt" in range) return Prisma.sql`i.due_date < ${isoDay(range.lt)}::date`;
  if ("equals" in range) return Prisma.sql`i.due_date = ${isoDay(range.equals)}::date`;
  return Prisma.sql`i.due_date > ${isoDay(range.gt)}::date AND i.due_date <= ${isoDay(
    range.lte,
  )}::date`;
}

type BookDueDateRange = ReturnType<typeof computedStatusDueDateRange>;

/**
 * The book's filters, written BOTH ways: as Prisma's `where` for the rows and
 * the count, and as SQL for the per-currency money.
 *
 * ⚠️ THE SAME QUESTION IN TWO LANGUAGES, AND ONLY A TEST KEEPS THEM HONEST.
 * The money cannot go through Prisma's aggregate because the balance is clamped
 * per row (see `moneyByCurrency`), so the filter has to be expressed twice.
 * They are built here, side by side, from one set of inputs so a change to one
 * is impossible to make without seeing the other — and `invoices.spec.ts`
 * asserts that the per-currency counts add up to `totalCount` across every
 * filter, which is the only way a drift between them gets caught mechanically
 * rather than by a customer reading two different numbers on one screen.
 *
 * ⚠️ A COMPUTED STATUS CANNOT BE FILTERED AS A STATUS. `overdue` is derived per
 * request from the due date and the ORG's timezone — deliberately not a column
 * (plan §7.1) — so it becomes a due-date range, which is the same question in a
 * form the database can answer. That also keeps paging honest: filtering after
 * paging would ask for ten rows and show three.
 */
function bookFilters(
  filters: { status?: string; currency?: string; customerId?: string; search?: string },
  today: Date,
): { where: Prisma.InvoiceWhereInput; sql: Prisma.Sql } {
  const dueDateFilter = computedStatusDueDateRange(filters.status, today);

  const where: Prisma.InvoiceWhereInput = {
    deletedAt: null,
    ...(filters.customerId !== undefined ? { customerId: filters.customerId } : {}),
    ...(filters.currency !== undefined ? { currency: filters.currency.toUpperCase() } : {}),
    ...(dueDateFilter !== null
      ? // A computed status always means the invoice is being CHASED — the
        // derivation never applies to anything else.
        { status: { in: [...CHASED_INVOICE_STATUSES] }, dueDate: dueDateFilter }
      : filters.status !== undefined
        ? { status: filters.status }
        : {}),
    ...(filters.search
      ? {
          OR: [
            { invoiceNumber: { contains: filters.search, mode: "insensitive" as const } },
            { customer: { name: { contains: filters.search, mode: "insensitive" as const } } },
          ],
        }
      : {}),
  };

  const conditions: Prisma.Sql[] = [Prisma.sql`i.deleted_at IS NULL`];
  if (filters.customerId !== undefined) {
    conditions.push(Prisma.sql`i.customer_id = ${filters.customerId}::uuid`);
  }
  if (filters.currency !== undefined) {
    conditions.push(Prisma.sql`i.currency = ${filters.currency.toUpperCase()}`);
  }
  if (dueDateFilter !== null) {
    conditions.push(
      Prisma.sql`i.status IN (${Prisma.join([...CHASED_INVOICE_STATUSES])})`,
      dueDateCondition(dueDateFilter),
    );
  } else if (filters.status !== undefined) {
    conditions.push(Prisma.sql`i.status = ${filters.status}`);
  }
  if (filters.search) {
    // `contains` + `mode: insensitive` is ILIKE with the term between wildcards.
    // Any `%` the customer types stays a wildcard in BOTH forms, which is what
    // makes them agree — the spec searches for one on purpose.
    const pattern = `%${filters.search}%`;
    conditions.push(
      Prisma.sql`(i.invoice_number ILIKE ${pattern} OR EXISTS (
        SELECT 1 FROM customers c WHERE c.id = i.customer_id AND c.name ILIKE ${pattern}
      ))`,
    );
  }

  return { where, sql: Prisma.join(conditions, " AND ") };
}

@Injectable()
export class InvoicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly usersService: UsersService,
  ) {}

  /** Lists a customer's invoices — invoices:read. Filters: status (stored or
   *  computed), contactId. Soft-deleted rows are excluded. */
  async list(
    authUser: AuthUser,
    organisationId: string,
    customerId: string,
    filters: { status?: string; contactId?: string },
  ): Promise<InvoiceSummary[]> {
    const user = await this.usersService.resolveOrProvision(authUser);
    return withTenant(this.prisma.db, { organisationId, userId: user.id }, async (tx) => {
      await requirePermission(tx, organisationId, user.id, "invoices:read");
      await this.requireCustomer(tx, customerId);
      const timezone = await this.orgTimezone(tx, organisationId);
      const rows = await tx.invoice.findMany({
        where: { customerId, deletedAt: null },
        orderBy: [{ dueDate: "asc" }, { invoiceNumber: "asc" }],
        include: WITH_CONTACT,
      });
      const blockers = await this.chaseBlockersFor(tx, organisationId, rows);
      let summaries = rows.map((row) =>
        this.toSummary(row, timezone, blockers.get(row.id) ?? null),
      );
      if (filters.status !== undefined) {
        const status = filters.status;
        const isStored = (INVOICE_STORED_STATUSES as readonly string[]).includes(status);
        const isComputed = (INVOICE_COMPUTED_STATUSES as readonly string[]).includes(status);
        if (!isStored && !isComputed) {
          throw new BadRequestException(`Unknown invoice status filter '${status}'`);
        }
        summaries = summaries.filter((summary) =>
          isComputed ? summary.displayStatus === status : summary.status === status,
        );
      }
      if (filters.contactId !== undefined) {
        summaries = summaries.filter((summary) => summary.contactId === filters.contactId);
      }
      return summaries;
    });
  }

  /**
   * The organisation's whole book, one row per invoice (slice 1.6c, task 9).
   *
   * ⚠️ ONE ROW PER INVOICE, NOT PER CLIENT. A client with three unpaid invoices
   * needs three rows, or you cannot chase one and hold another, and "amount
   * due" becomes a total that hides which one is late.
   *
   * ⚠️ THE QUERY COUNT DOES NOT GROW WITH THE BOOK. Everything per-row is
   * either loaded with the invoice or batched: the chase blockers cost two
   * queries for any number of rows, and the chase dates one grouped query for
   * the page. The obvious implementation asks per invoice and is fine on the
   * demo book's fifteen rows.
   */
  async listForOrganisation(
    authUser: AuthUser,
    organisationId: string,
    filters: {
      status?: string;
      currency?: string;
      customerId?: string;
      search?: string;
      limit?: number;
      offset?: number;
    },
  ): Promise<InvoiceBook> {
    const user = await this.usersService.resolveOrProvision(authUser);
    return withTenant(this.prisma.db, { organisationId, userId: user.id }, async (tx) => {
      await requirePermission(tx, organisationId, user.id, "invoices:read");
      const timezone = await this.orgTimezone(tx, organisationId);

      if (filters.status !== undefined) {
        const isStored = (INVOICE_STORED_STATUSES as readonly string[]).includes(filters.status);
        const isComputed = (INVOICE_COMPUTED_STATUSES as readonly string[]).includes(
          filters.status,
        );
        if (!isStored && !isComputed) {
          throw new BadRequestException(`Unknown invoice status filter '${filters.status}'`);
        }
      }

      const today = todayInTimezone(timezone);
      const { where, sql } = bookFilters(filters, today);

      const take = Math.min(Math.max(filters.limit ?? 50, 1), MAX_BOOK_PAGE);
      const skip = Math.max(filters.offset ?? 0, 0);

      const [rows, totalCount] = await Promise.all([
        tx.invoice.findMany({
          where,
          // Most overdue first: the top of this screen should be the thing that
          // needs doing today.
          orderBy: [{ dueDate: "asc" }, { invoiceNumber: "asc" }],
          include: {
            ...WITH_CONTACT,
            customer: { select: { id: true, name: true, reference: true } },
          },
          take,
          skip,
        }),
        tx.invoice.count({ where }),
      ]);

      const blockers = await this.chaseBlockersFor(tx, organisationId, rows);
      const chaseDates = await this.chaseDatesFor(
        tx,
        rows.map((row) => row.id),
      );

      const [chasedByCurrency, matchedByCurrency] = await Promise.all([
        this.chasedByCurrency(tx, organisationId),
        this.moneyByCurrency(tx, organisationId, sql),
      ]);

      return {
        rows: rows.map((row) => {
          const dates = chaseDates.get(row.id);
          return {
            ...this.toSummary(row, timezone, blockers.get(row.id) ?? null),
            customer: row.customer,
            contact: row.contact
              ? {
                  id: row.contact.id,
                  name: row.contact.name,
                  email: row.contact.email,
                  phone: row.contact.phone,
                }
              : null,
            lastChasedOn: dates?.lastChasedOn ?? null,
            nextChaseOn: dates?.nextChaseOn ?? null,
            ageingBucket: ageingBucketFor(row.dueDate, today),
          };
        }),
        totalCount,
        chasedByCurrency,
        matchedByCurrency,
      };
    });
  }

  /**
   * When each invoice was last chased and when it is next due to be — ONE
   * grouped query for the whole page.
   *
   * `scheduled_date` is the org-local calendar day the action belongs to, so no
   * timezone work happens here; the scheduler already did it.
   */
  private async chaseDatesFor(
    tx: TenantTx,
    invoiceIds: string[],
  ): Promise<Map<string, { lastChasedOn: Date | null; nextChaseOn: Date | null }>> {
    const dates = new Map<string, { lastChasedOn: Date | null; nextChaseOn: Date | null }>();
    if (invoiceIds.length === 0) return dates;

    const grouped = await tx.scheduledAction.groupBy({
      by: ["invoiceId", "status"],
      where: {
        invoiceId: { in: invoiceIds },
        // `sent` is the only status that means a debtor actually heard from us;
        // pending/ready are what is still to come. Everything else — cancelled,
        // failed, skipped — is neither, and must not be reported as a chase.
        status: { in: ["sent", "pending", "ready"] },
      },
      _max: { scheduledDate: true },
      _min: { scheduledDate: true },
    });

    for (const group of grouped) {
      const entry = dates.get(group.invoiceId) ?? { lastChasedOn: null, nextChaseOn: null };
      if (group.status === "sent") {
        const sent = group._max.scheduledDate;
        if (sent && (entry.lastChasedOn === null || sent > entry.lastChasedOn)) {
          entry.lastChasedOn = sent;
        }
      } else {
        const next = group._min.scheduledDate;
        if (next && (entry.nextChaseOn === null || next < entry.nextChaseOn)) {
          entry.nextChaseOn = next;
        }
      }
      dates.set(group.invoiceId, entry);
    }
    return dates;
  }

  /**
   * What the organisation is owed, per currency, over CHASED invoices only.
   *
   * ⚠️ RAW SQL BECAUSE THE BALANCE IS CLAMPED. `SUM(amount) - SUM(paid)` is NOT
   * the same number: overpayment is allowed, so an invoice paid 25 over would
   * quietly eat 25 off another invoice's balance and understate the total. The
   * clamp has to happen per row, which is what `GREATEST(..., 0)` does — the
   * same rule as `outstandingBalance` in `@eva/types`.
   */
  private async chasedByCurrency(tx: TenantTx, organisationId: string): Promise<CurrencyTotal[]> {
    return this.moneyByCurrency(
      tx,
      organisationId,
      Prisma.sql`i.deleted_at IS NULL AND i.status IN (${Prisma.join([
        ...CHASED_INVOICE_STATUSES,
      ])})`,
    );
  }

  /**
   * The clamped balance per currency, over whatever `conditions` select.
   *
   * ⚠️ RAW SQL BECAUSE THE BALANCE IS CLAMPED, and that is not a style choice —
   * it is why Prisma's own aggregate cannot be used here. `SUM(amount) -
   * SUM(paid)` is a DIFFERENT number: overpayment is allowed, so an invoice
   * paid 25 over would quietly eat 25 off another invoice's balance and
   * understate the total. The clamp has to happen per row, which is what
   * `GREATEST(..., 0)` does — the same rule as `outstandingBalance` in
   * `@eva/types`.
   *
   * `organisation_id` is asserted here as well as by RLS: this is hand-written
   * SQL, and a tenant boundary should not rest on one mechanism.
   */
  private async moneyByCurrency(
    tx: TenantTx,
    organisationId: string,
    conditions: Prisma.Sql,
  ): Promise<CurrencyTotal[]> {
    const rows = await tx.$queryRaw<
      { currency: string; invoice_count: bigint; outstanding: bigint | null }[]
    >`
      SELECT i.currency,
             COUNT(*) AS invoice_count,
             SUM(GREATEST(i.amount_minor_units - i.amount_paid_minor_units, 0)) AS outstanding
        FROM invoices i
       WHERE i.organisation_id = ${organisationId}::uuid
         AND ${conditions}
       GROUP BY i.currency
       ORDER BY i.currency
    `;
    return rows.map((row) => ({
      currency: row.currency,
      invoiceCount: Number(row.invoice_count),
      outstandingMinorUnits: minorUnitsToNumber(row.outstanding ?? 0n),
    }));
  }

  /** Creates an invoice as Draft (or Active when already sent) — invoices:write. */
  async create(
    authUser: AuthUser,
    organisationId: string,
    customerId: string,
    input: CreateInvoiceRequest,
  ): Promise<InvoiceSummary> {
    const user = await this.usersService.resolveOrProvision(authUser);
    return withTenant(this.prisma.db, { organisationId, userId: user.id }, async (tx) => {
      await requirePermission(tx, organisationId, user.id, "invoices:write");
      await this.requireCustomer(tx, customerId);
      if (input.contactId !== undefined) {
        await this.requireContactOfCustomer(tx, customerId, input.contactId);
      }
      return this.createInvoiceInTx(tx, organisationId, user.id, customerId, input);
    });
  }

  /**
   * Creating the invoice row itself, inside a caller's transaction.
   *
   * ⚠️ EXTRACTED SO THE TABLE'S "ADD A ROW" IS THE SAME ACT, not a second one
   * that drifts. Typing a row and raising an invoice from a client's page must
   * audit identically, schedule identically and refuse a duplicate number
   * identically — this project has already watched the api and the web keep
   * separate copies of one rule and disagree within the hour.
   */
  private async createInvoiceInTx(
    tx: TenantTx,
    organisationId: string,
    userId: string,
    customerId: string,
    input: CreateInvoiceRequest,
  ): Promise<InvoiceSummary> {
    await this.ensureInvoiceNumberAvailable(tx, organisationId, input.invoiceNumber);
    const timezone = await this.orgTimezone(tx, organisationId);
    const invoice = await this.createRow(tx, {
      organisationId,
      customerId,
      contactId: input.contactId ?? null,
      invoiceNumber: input.invoiceNumber,
      amountMinorUnits: input.amountMinorUnits,
      currency: input.currency,
      issueDate:
        input.issueDate !== undefined ? new Date(input.issueDate) : todayInTimezone(timezone),
      dueDate: new Date(input.dueDate),
      status: input.status,
      createdBy: userId,
    });
    await writeAuditLog(tx, {
      organisationId,
      actorUserId: userId,
      action: "invoice.created",
      entityType: "invoice",
      entityId: invoice.id,
      metadata: { customerId, invoiceNumber: invoice.invoiceNumber, status: invoice.status },
    });
    // Slice 1.5: an invoice created directly as Active ("already sent") gets
    // the same schedule a Draft→Active activation would — in the same
    // transaction, so a scheduling failure rolls the create back too.
    if (invoice.status === "active") {
      await scheduleInvoiceReminders(tx, {
        organisationId,
        invoiceId: invoice.id,
        timezone,
        actorUserId: userId,
      });
    }
    return this.toSummary(
      invoice,
      timezone,
      await this.chaseBlockerFor(tx, organisationId, invoice),
    );
  }

  /**
   * Add a row to the book: client, contact and invoice in one act (slice 1.6c).
   *
   * ⚠️ THE CLIENT IS RESOLVED THE WAY THE IMPORTER RESOLVES IT — the shared
   * `resolveCustomer` in `common/ledger`, by reference then case-insensitive
   * exact name, where **ambiguous is an error and never a guess**. Typing a row
   * and uploading the same row must land in the same place; a second matching
   * rule here is how one client quietly becomes two.
   *
   * ⚠️ UNLIKE AN IMPORT, THIS MAY START CHASING IMMEDIATELY. Imported invoices
   * are forced to Draft because nobody has read them; a row somebody has just
   * typed has been read by definition, which is the same reasoning the
   * per-client "Add an invoice" form already uses.
   */
  async addBookRow(
    authUser: AuthUser,
    organisationId: string,
    input: AddBookRowRequest,
  ): Promise<InvoiceSummary> {
    const user = await this.usersService.resolveOrProvision(authUser);
    return withTenant(this.prisma.db, { organisationId, userId: user.id }, async (tx) => {
      await requirePermission(tx, organisationId, user.id, "invoices:write");

      /** The importer's own row shape — one typed row IS a one-row import. */
      const canonical: CanonicalRow = {
        customerName: input.clientName,
        ...(input.clientEmail ? { customerEmail: input.clientEmail } : {}),
        ...(input.clientReference ? { customerReference: input.clientReference } : {}),
        ...(input.contactName ? { contactName: input.contactName } : {}),
        ...(input.contactEmail ? { contactEmail: input.contactEmail } : {}),
      };

      const resolution = resolveCustomer(canonical, await listLiveCustomers(tx));
      if (resolution.kind === "ambiguous") {
        throw new ConflictException(
          `More than one client is called '${input.clientName}'. Open the client you mean and add the invoice there.`,
        );
      }
      const customerId =
        resolution.kind === "matched"
          ? resolution.customerId
          : (await createCustomerFromCanonical(tx, organisationId, user.id, canonical)).id;

      const contactId = await resolveOrCreateContact(
        tx,
        organisationId,
        user.id,
        customerId,
        canonical,
      );

      /**
       * ⚠️ THE PHONE IS WRITTEN HERE AND NOT BY THE LEDGER, because the
       * importer's canonical fields have no phone column — a phone column in an
       * uploaded spreadsheet is ignored today. Typed rows can carry one, which
       * is the difference the upload screen states out loud rather than leaving
       * somebody to discover. Stored in E.164 so a dialler can use it.
       */
      if (contactId !== null && input.contactPhone) {
        await tx.contact.update({ where: { id: contactId }, data: { phone: input.contactPhone } });
      }

      return this.createInvoiceInTx(tx, organisationId, user.id, customerId, {
        invoiceNumber: input.invoiceNumber,
        amountMinorUnits: input.amountMinorUnits,
        currency: input.currency,
        ...(input.issueDate !== undefined ? { issueDate: input.issueDate } : {}),
        dueDate: input.dueDate,
        ...(contactId !== null ? { contactId } : {}),
        status: input.status,
      });
    });
  }

  /** Reads one invoice — invoices:read. Cross-tenant/deleted ids are 404. */
  async getById(
    authUser: AuthUser,
    organisationId: string,
    customerId: string,
    invoiceId: string,
  ): Promise<InvoiceSummary> {
    const user = await this.usersService.resolveOrProvision(authUser);
    return withTenant(this.prisma.db, { organisationId, userId: user.id }, async (tx) => {
      await requirePermission(tx, organisationId, user.id, "invoices:read");
      const timezone = await this.orgTimezone(tx, organisationId);
      const invoice = await this.findOrThrow(tx, customerId, invoiceId);
      return this.toSummary(
        invoice,
        timezone,
        await this.chaseBlockerFor(tx, organisationId, invoice),
      );
    });
  }

  /** Updates a DRAFT invoice — invoices:write. Never touches status (BRD 4.1). */
  async update(
    authUser: AuthUser,
    organisationId: string,
    customerId: string,
    invoiceId: string,
    input: UpdateInvoiceRequest,
  ): Promise<InvoiceSummary> {
    const user = await this.usersService.resolveOrProvision(authUser);
    return withTenant(this.prisma.db, { organisationId, userId: user.id }, async (tx) => {
      await requirePermission(tx, organisationId, user.id, "invoices:write");
      const existing = await this.findOrThrow(tx, customerId, invoiceId);
      this.requireDraft(existing, "updated");
      /**
       * `null` is an explicit "nobody", and there is nothing to look up.
       *
       * Distinct from ABSENT, which means "leave the recipient alone". Without
       * this branch a null would be handed to `findFirst` and come back as
       * "contactId must reference a contact of this customer" — refusing the one
       * request that removes a wrongly chosen recipient.
       */
      if (input.contactId !== undefined && input.contactId !== null) {
        await this.requireContactOfCustomer(tx, customerId, input.contactId);
      }
      if (input.invoiceNumber !== undefined && input.invoiceNumber !== existing.invoiceNumber) {
        await this.ensureInvoiceNumberAvailable(tx, organisationId, input.invoiceNumber, invoiceId);
      }
      const invoice = await tx.invoice.update({
        where: { id: invoiceId },
        include: WITH_CONTACT,
        data: {
          ...(input.invoiceNumber !== undefined ? { invoiceNumber: input.invoiceNumber } : {}),
          ...(input.amountMinorUnits !== undefined
            ? { amountMinorUnits: input.amountMinorUnits }
            : {}),
          ...(input.currency !== undefined ? { currency: input.currency } : {}),
          ...(input.issueDate !== undefined ? { issueDate: new Date(input.issueDate) } : {}),
          ...(input.dueDate !== undefined ? { dueDate: new Date(input.dueDate) } : {}),
          ...(input.contactId !== undefined ? { contactId: input.contactId } : {}),
        },
      });
      await writeAuditLog(tx, {
        organisationId,
        actorUserId: user.id,
        action: "invoice.updated",
        entityType: "invoice",
        entityId: invoice.id,
        metadata: {
          changedFields: Object.keys(input).filter(
            (key) => input[key as keyof UpdateInvoiceRequest] !== undefined,
          ),
        },
      });
      const timezone = await this.orgTimezone(tx, organisationId);
      return this.toSummary(
        invoice,
        timezone,
        await this.chaseBlockerFor(tx, organisationId, invoice),
      );
    });
  }

  /** Soft-deletes a DRAFT invoice (BRD 10) — invoices:write. Audit-logged. */
  async remove(
    authUser: AuthUser,
    organisationId: string,
    customerId: string,
    invoiceId: string,
  ): Promise<void> {
    const user = await this.usersService.resolveOrProvision(authUser);
    await withTenant(this.prisma.db, { organisationId, userId: user.id }, async (tx) => {
      await requirePermission(tx, organisationId, user.id, "invoices:write");
      const existing = await this.findOrThrow(tx, customerId, invoiceId);
      this.requireDraft(existing, "deleted");
      await tx.invoice.update({ where: { id: invoiceId }, data: { deletedAt: new Date() } });
      await writeAuditLog(tx, {
        organisationId,
        actorUserId: user.id,
        action: "invoice.deleted",
        entityType: "invoice",
        entityId: invoiceId,
        metadata: { customerId },
      });
    });
  }

  /**
   * State-machine actions — invoices:write. activate: Draft→Active;
   * pause: Active→Paused; resume: Paused→Active; cancel: Draft/Active/
   * Paused→Cancelled. Everything else is rejected by the state machine (409).
   * The Slice 1.5 reminder schedule is kept in lockstep INSIDE the same
   * transaction (plan §3 recompute triggers; BRD 4.1) — a scheduling failure
   * rolls the status change back with it.
   */
  async transition(
    authUser: AuthUser,
    organisationId: string,
    customerId: string,
    invoiceId: string,
    /* The FOUR only. The payment transitions are not reachable here by design —
       they require money, and that is `recordPayment`'s job. */
    action: InvoiceLifecycleAction,
  ): Promise<InvoiceSummary> {
    const user = await this.usersService.resolveOrProvision(authUser);
    return withTenant(this.prisma.db, { organisationId, userId: user.id }, async (tx) => {
      await requirePermission(tx, organisationId, user.id, "invoices:write");
      const existing = await this.findOrThrow(tx, customerId, invoiceId);
      const to = await transitionInvoiceStatus(tx, invoiceId, existing.status, action);
      await writeAuditLog(tx, {
        organisationId,
        actorUserId: user.id,
        action: "invoice.status_changed",
        entityType: "invoice",
        entityId: invoiceId,
        metadata: { from: existing.status, to },
      });
      const timezone = await this.orgTimezone(tx, organisationId);
      await this.syncReminderSchedule(tx, organisationId, invoiceId, action, timezone, user.id);
      const invoice = await tx.invoice.findUniqueOrThrow({
        where: { id: invoiceId },
        include: WITH_CONTACT,
      });
      return this.toSummary(
        invoice,
        timezone,
        await this.chaseBlockerFor(tx, organisationId, invoice),
      );
    });
  }

  /**
   * Record a payment against an invoice (slice 1.6c, task 5) — invoices:write.
   *
   * ⚠️ THE DEFECT THIS EXISTS TO FIX. Until now a debtor who owed 10,000 and
   * paid 6,000 left two bad choices: leave the invoice Active and Eva chases
   * the FULL 10,000, or cancel it and Eva stops chasing the 4,000 still owed.
   * Migration 0019 added `amount_paid_minor_units` for exactly this and nothing
   * ever wrote to it.
   *
   * ⚠️ THE STATUS IS DECIDED BY THE BALANCE, NOT BY THE CALLER, and it still
   * moves through the state machine (BRD 4.1 hard rule). There is no "mark as
   * paid" anywhere in this API: the only way to reach `paid` is to record money
   * that clears the balance, in the same transaction that writes it.
   */
  async recordPayment(
    authUser: AuthUser,
    organisationId: string,
    customerId: string,
    invoiceId: string,
    input: RecordPaymentRequest,
  ): Promise<InvoiceSummary> {
    const user = await this.usersService.resolveOrProvision(authUser);
    return withTenant(this.prisma.db, { organisationId, userId: user.id }, async (tx) => {
      await requirePermission(tx, organisationId, user.id, "invoices:write");
      const existing = await this.findOrThrow(tx, customerId, invoiceId);

      /**
       * A draft has not been issued, so there is nothing to have been paid.
       * Refused here rather than by the state machine because the state machine
       * would answer "cannot pay_in_part from status 'draft'", and the useful
       * thing to say is that the invoice was never sent.
       */
      if (existing.status === "draft") {
        throw new ConflictException(
          "This invoice is still a draft, so there is nothing to pay yet. Start chasing it first.",
        );
      }

      const paid = existing.amountPaidMinorUnits + BigInt(input.amountMinorUnits);
      const settled = paid >= existing.amountMinorUnits;

      /**
       * ⚠️ THE MONEY AND THE STATUS MOVE IN ONE TRANSACTION. Written first so
       * that an illegal transition — a payment against a cancelled invoice, say
       * — takes the money write down with it. A recorded payment on an invoice
       * whose status did not follow is the two-numbers-disagree failure this
       * whole slice is about.
       */
      await tx.invoice.update({
        where: { id: invoiceId },
        data: {
          amountPaidMinorUnits: paid,
          lastPaymentAt: input.paidAt !== undefined ? new Date(input.paidAt) : new Date(),
        },
      });

      /**
       * A part payment against a PAUSED invoice changes no status at all.
       *
       * Somebody paused that chase deliberately — a query, a dispute — and them
       * banking a part payment is not them asking for it to start again. Moving
       * it to `partially_paid` would silently resume chasing, because
       * `partially_paid` is a chased status. Settling it in full is different:
       * "they have paid" is true whatever the chase was doing.
       */
      const action: InvoiceAction | null = settled
        ? "pay_in_full"
        : existing.status === "paused"
          ? null
          : "pay_in_part";

      let to = existing.status;
      if (action !== null) {
        to = await transitionInvoiceStatus(tx, invoiceId, existing.status, action);
      }

      await writeAuditLog(tx, {
        organisationId,
        actorUserId: user.id,
        action: "invoice.payment_recorded",
        entityType: "invoice",
        entityId: invoiceId,
        // No amount: audit metadata carries counts, ids and outcomes, never
        // money or personal data (BRD 14). What was paid lives on the invoice.
        metadata: { from: existing.status, to, settled },
      });

      const timezone = await this.orgTimezone(tx, organisationId);
      /**
       * A settled invoice stops being chased, so its queued reminders are
       * cancelled — in the same transaction, like every other lifecycle hook.
       * A PART payment cancels nothing: the schedule was built from the due
       * date and the remaining balance is owed on exactly those dates. That is
       * the whole point of being able to record one.
       */
      if (settled) {
        await cancelInvoiceReminders(tx, {
          organisationId,
          invoiceId,
          reason: "invoice_paid",
          actorUserId: user.id,
        });
      }

      const invoice = await tx.invoice.findUniqueOrThrow({
        where: { id: invoiceId },
        include: WITH_CONTACT,
      });
      return this.toSummary(
        invoice,
        timezone,
        await this.chaseBlockerFor(tx, organisationId, invoice),
      );
    });
  }

  /**
   * Slice 1.5 (plan §3): the reminder-schedule side effect of each legal
   * transition. activate schedules; pause/cancel cancel every live row;
   * resume recomputes from today (cancel + fresh rows — migration 0011 keeps
   * cancelled rows as history). Draft invoices carry no schedule, so a cancel
   * from Draft is a no-op. The 1.2 PATCH is Draft-only, so no path can edit
   * an Active invoice's due_date and there is no due-date recompute hook.
   */
  private async syncReminderSchedule(
    tx: TenantTx,
    organisationId: string,
    invoiceId: string,
    action: InvoiceLifecycleAction,
    timezone: string,
    actorUserId: string,
  ): Promise<void> {
    switch (action) {
      case "activate":
        await scheduleInvoiceReminders(tx, { organisationId, invoiceId, timezone, actorUserId });
        break;
      case "resume":
        await recomputeInvoiceReminders(tx, { organisationId, invoiceId, timezone, actorUserId });
        break;
      case "pause":
        await cancelInvoiceReminders(tx, {
          organisationId,
          invoiceId,
          reason: "invoice_paused",
          actorUserId,
        });
        break;
      case "cancel":
        await cancelInvoiceReminders(tx, {
          organisationId,
          invoiceId,
          reason: "invoice_cancelled",
          actorUserId,
        });
        break;
      default: {
        // Compile-time exhaustiveness: a future InvoiceAction must wire its
        // schedule side effect here, not silently no-op.
        const exhaustive: never = action;
        throw new Error(`Unhandled invoice action '${exhaustive as string}'`);
      }
    }
  }

  /** Parent customer must exist live in the active tenant — else 404 (BRD 15). */
  private async requireCustomer(tx: TenantTx, customerId: string): Promise<void> {
    const customer = await tx.customer.findFirst({ where: { id: customerId, deletedAt: null } });
    if (!customer) throw new NotFoundException("Customer not found");
  }

  /** contact_id must reference a live contact OF THIS CUSTOMER (plan §7.2). */
  private async requireContactOfCustomer(
    tx: TenantTx,
    customerId: string,
    contactId: string,
  ): Promise<void> {
    const contact = await tx.contact.findFirst({
      where: { id: contactId, customerId, deletedAt: null },
    });
    if (!contact) {
      throw new BadRequestException("contactId must reference a contact of this customer");
    }
  }

  private requireDraft(invoice: InvoiceRow, verb: string): void {
    if (invoice.status !== "draft") {
      throw new ConflictException(`Only draft invoices can be ${verb}`);
    }
  }

  /** Duplicate invoice number (among live rows) → friendly 409 (plan §7.4). */
  private async ensureInvoiceNumberAvailable(
    tx: TenantTx,
    organisationId: string,
    invoiceNumber: string,
    excludeId?: string,
  ): Promise<void> {
    const clash = await tx.invoice.findFirst({
      where: {
        organisationId,
        invoiceNumber,
        deletedAt: null,
        ...(excludeId !== undefined ? { id: { not: excludeId } } : {}),
      },
    });
    if (clash) {
      throw new ConflictException(
        `Invoice number '${invoiceNumber}' is already in use in this organisation`,
      );
    }
  }

  /** Creates the row, converting a unique-index race into the same friendly 409. */
  private async createRow(
    tx: TenantTx,
    data: Prisma.InvoiceUncheckedCreateInput,
  ): Promise<InvoiceRow> {
    try {
      return await tx.invoice.create({ data, include: WITH_CONTACT });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ConflictException(
          `Invoice number '${data.invoiceNumber}' is already in use in this organisation`,
        );
      }
      throw error;
    }
  }

  /**
   * Why Eva could not chase each of these invoices — keyed by invoice id.
   *
   * ⚠️ AT MOST TWO EXTRA QUERIES, WHATEVER THE LENGTH OF THE LIST, and that is
   * the whole design. The obvious implementation calls `isSuppressed` and
   * resolves a mailbox per row, which is a textbook N+1 — invisible against the
   * demo book's fifteen invoices and ruinous on the org-wide list task 9 adds.
   *
   * The contact travels with the invoice (`WITH_CONTACT`), so most rows are
   * decided with no query at all; only rows that survive that ask about
   * suppression, and only rows that survive THAT ask whether the organisation
   * has a mailbox at all.
   */
  private async chaseBlockersFor(
    tx: TenantTx,
    organisationId: string,
    invoices: InvoiceRow[],
  ): Promise<Map<string, ChaseBlockedReason | null>> {
    const blockers = new Map<string, ChaseBlockedReason | null>();
    const undecided: { id: string; email: string }[] = [];

    for (const invoice of invoices) {
      // Suppression and the mailbox are assumed CLEAR here on purpose: this
      // pass only settles the reasons the loaded contact can answer by itself.
      const reason = resolveChaseBlockedReason({
        contact: invoice.contact ?? null,
        suppressed: false,
        organisationHasHealthyMailbox: true,
      });
      if (reason !== null) blockers.set(invoice.id, reason);
      else undecided.push({ id: invoice.id, email: invoice.contact?.email ?? "" });
    }

    if (undecided.length === 0) return blockers;

    const values = [
      ...new Set(undecided.map((row) => normaliseSuppressionValue("email", row.email))),
    ];
    const suppressed = new Set(
      (
        await tx.suppressionEntry.findMany({
          where: { organisationId, channel: "email", value: { in: values } },
          select: { value: true },
        })
      ).map((row) => row.value),
    );

    const stillUndecided = undecided.filter((row) => {
      if (suppressed.has(normaliseSuppressionValue("email", row.email))) {
        blockers.set(row.id, "suppressed");
        return false;
      }
      return true;
    });
    if (stillUndecided.length === 0) return blockers;

    /**
     * "Healthy" is defined here EXACTLY as `resolveSendingMailbox` defines it —
     * live and `active` — because null from that resolver is what this is
     * predicting. A looser definition here would promise a chase the sender
     * then refuses, which is the defect one layer along.
     */
    const healthyMailboxes = await tx.emailAccount.count({
      where: { deletedAt: null, healthStatus: "active" },
    });
    for (const row of stillUndecided) {
      blockers.set(row.id, healthyMailboxes > 0 ? null : "no_mailbox");
    }
    return blockers;
  }

  /** The single-invoice case, so every caller returns the same shape. */
  private async chaseBlockerFor(
    tx: TenantTx,
    organisationId: string,
    invoice: InvoiceRow,
  ): Promise<ChaseBlockedReason | null> {
    return (await this.chaseBlockersFor(tx, organisationId, [invoice])).get(invoice.id) ?? null;
  }

  /** The org's business timezone (BRD 18.1); default Europe/London. */
  private async orgTimezone(tx: TenantTx, organisationId: string): Promise<string> {
    const settings = await tx.organisationSettings.findUnique({ where: { organisationId } });
    return settings?.timezone ?? DEFAULT_TIMEZONE;
  }

  private async findOrThrow(
    tx: TenantTx,
    customerId: string,
    invoiceId: string,
  ): Promise<InvoiceRow> {
    const invoice = await tx.invoice.findFirst({
      where: { id: invoiceId, customerId, deletedAt: null },
      include: WITH_CONTACT,
    });
    if (!invoice) throw new NotFoundException("Invoice not found");
    return invoice;
  }

  /**
   * Row → response, field by field. Deliberately NOT a spread.
   *
   * Two reasons, and the first is a bug waiting to happen. Money is `bigint`
   * since migration 0021 and `JSON.stringify` throws on a bigint, so a spread
   * would put one straight into a response; `minorUnitsToNumber` converts it and
   * throws rather than silently losing precision. Second, `findFirst` selects
   * every scalar, so the old spread was shipping `organisationId`, `createdBy`,
   * `deletedAt` and every migration-0019 column to the browser purely because
   * they existed. An explicit list means adding a column to the schema is no
   * longer the same act as publishing it.
   */
  private toSummary(
    invoice: InvoiceRow,
    timezone: string,
    chaseBlockedReason: ChaseBlockedReason | null,
  ): InvoiceSummary {
    return {
      chaseBlockedReason,
      id: invoice.id,
      customerId: invoice.customerId,
      contactId: invoice.contactId,
      invoiceNumber: invoice.invoiceNumber,
      amountMinorUnits: minorUnitsToNumber(invoice.amountMinorUnits),
      amountPaidMinorUnits: minorUnitsToNumber(invoice.amountPaidMinorUnits),
      outstandingMinorUnits: minorUnitsToNumber(
        outstandingBalance(invoice.amountMinorUnits, invoice.amountPaidMinorUnits),
      ),
      currency: invoice.currency,
      issueDate: invoice.issueDate,
      dueDate: invoice.dueDate,
      description: invoice.description,
      status: invoice.status,
      lastPaymentAt: invoice.lastPaymentAt,
      displayStatus: deriveDisplayStatus(invoice, timezone),
      createdAt: invoice.createdAt,
      updatedAt: invoice.updatedAt,
    };
  }
}
