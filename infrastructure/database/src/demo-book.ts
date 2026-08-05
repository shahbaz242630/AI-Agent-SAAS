import type { EvaPrismaClient } from "./client.js";
import { DEMO_ORGANISATION_ID } from "./seed.js";

/**
 * A DEVELOPMENT-ONLY book of realistic B2B debtors for the demo organisation
 * (slice 1.6c).
 *
 * ⚠️ LOCAL ONLY. `isLocalDatabase` in seed-cli.ts refuses to run this against
 * anything but localhost. These are invented companies with invented addresses;
 * the day 1.7 can send, a fake debtor in a real database is a real email to
 * nobody. The demo organisation is also flagged `is_demo`, which send paths
 * hard-exclude (BRD 18.6) — that is the second belt, not the first.
 *
 * WHY THIS EXISTS. Slice 1.6c builds the invoice screens, and a screen is only
 * as good as the data you develop it against. A book of one currency and one
 * status renders perfectly while hiding every defect this slice exists to
 * prevent. So the book below deliberately spans:
 *
 *   - all three ISO 4217 exponent groups — JPY (0 digits), GBP/AED (2),
 *     KWD (3). A list that hard-codes two decimal places is WRONG by a factor
 *     of ten for Al Mutawa, and you can see it.
 *   - all five ageing buckets — Current · 1-15 · 16-30 · 31-45 · >45
 *     (DATA-MODEL-REVIEW §4).
 *   - all four DISPLAY statuses — active, due_soon, due_today, overdue.
 *   - six of the nine STORED statuses. `promise_to_pay`, `disputed` and
 *     `written_off` are deliberately absent: they are slice 1.8, and seeding a
 *     state the product cannot produce would invite a screen that pretends it
 *     can.
 *   - MIXED currency inside one organisation, which is what makes the org-wide
 *     total in task 9 impossible to sum honestly (trap 3b). If every invoice
 *     here were GBP, that bug would ship.
 *   - the part-payment and the overpayment, which are the two cases the whole
 *     payments half of this slice exists for.
 *
 * ⚠️ AMOUNTS ARE WRITTEN AS LITERAL MINOR UNITS, on purpose. It would be
 * tidier to call `parseAmountToMinorUnits("12.345", "KWD")` here — and it would
 * be worthless: a fixture computed by the thing under test agrees with that
 * thing even when both are wrong. The literal is stated independently and
 * `demo-book.spec.ts` proves it round-trips through the real money helper. If
 * they ever disagree, the test fails instead of the data quietly matching a
 * broken parser.
 */

/** The demo owner, seeded by `seed()` — every row here is attributed to them. */
const DEMO_OWNER_ID = "00000000-0000-4000-8000-000000000001";

/**
 * Midnight UTC, `days` from today. `issue_date` and `due_date` are DATE
 * columns, so they must not carry a local-time component that could tip them
 * onto the neighbouring day.
 *
 * ⚠️ EVERY DATE HERE IS RELATIVE, and that is load-bearing. A fixture with
 * fixed dates drifts: an invoice seeded 40 days overdue is 90 days overdue two
 * months later, so it silently changes ageing bucket and the screen you thought
 * you were testing is testing something else. Re-seeding re-bases the whole
 * book to today.
 */
function daysFromToday(days: number, now: Date = new Date()): Date {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(today + days * 86_400_000);
}

interface DemoCustomer {
  name: string;
  email: string;
  /** Stable business key — how a re-seed finds this row in a given org. */
  reference: string;
  paymentTerms: string;
  contact: { name: string; email: string; jobTitle: string };
  /** What this debtor is like to deal with — the reason they are in the book. */
  behaviour: string;
  invoices: DemoInvoice[];
}

interface DemoInvoice {
  /** Stable business key — unique per organisation among live rows. */
  invoiceNumber: string;
  currency: string;
  /** Integer minor units for THIS currency. See the literal-amounts note above. */
  amountMinorUnits: bigint;
  amountPaidMinorUnits?: bigint;
  /** Days from today; negative is overdue. */
  dueInDays: number;
  /** Days from today, negative — when the invoice was raised. */
  issuedInDays: number;
  /** Days from today, negative — only for rows that have been paid against. */
  paidInDays?: number;
  status: string;
  description: string;
  customerReference?: string;
}

const DEMO_CUSTOMERS: readonly DemoCustomer[] = [
  {
    name: "Northwind Trading Ltd",
    email: "accounts@northwind-trading.example",
    reference: "NWT-001",
    paymentTerms: "Net 30",
    behaviour: "Pays on time. The control: Eva must never chase this customer.",
    contact: {
      name: "Helen Marsh",
      email: "helen.marsh@northwind-trading.example",
      jobTitle: "Accounts Payable",
    },
    invoices: [
      {
        // £2,450.00 — not yet due. Bucket: Current. Display: active.
        invoiceNumber: "INV-1001",
        currency: "GBP",
        amountMinorUnits: 245_000n,
        dueInDays: 21,
        issuedInDays: -9,
        status: "active",
        description: "Q3 wholesale order — pallet delivery",
        customerReference: "PO-88214",
      },
      {
        // £1,800.00 — paid in full, two days BEFORE it fell due.
        invoiceNumber: "INV-1002",
        currency: "GBP",
        amountMinorUnits: 180_000n,
        amountPaidMinorUnits: 180_000n,
        dueInDays: -20,
        issuedInDays: -50,
        paidInDays: -22,
        status: "paid",
        description: "Q2 wholesale order",
        customerReference: "PO-87903",
      },
      {
        // £320.00 — cancelled, NOT paid. Trap 7: no label may imply otherwise.
        invoiceNumber: "INV-1003",
        currency: "GBP",
        amountMinorUnits: 32_000n,
        dueInDays: -50,
        issuedInDays: -80,
        status: "cancelled",
        description: "Duplicate of INV-1002 — raised in error",
      },
    ],
  },
  {
    name: "Perrin Construction Ltd",
    email: "finance@perrin-construction.example",
    reference: "PCL-014",
    paymentTerms: "Net 30",
    behaviour: "Reliably about two weeks late. The bread-and-butter debtor.",
    contact: {
      name: "Dan Okafor",
      email: "dan.okafor@perrin-construction.example",
      jobTitle: "Finance Manager",
    },
    invoices: [
      {
        // £5,600.00 — due in 2 days. Display: DUE_SOON (the <= 3 day window).
        invoiceNumber: "INV-2001",
        currency: "GBP",
        amountMinorUnits: 560_000n,
        dueInDays: 2,
        issuedInDays: -28,
        status: "active",
        description: "Groundworks — phase 1",
        customerReference: "PC-2291",
      },
      {
        // £3,250.00 — due TODAY. Display: DUE_TODAY. The one row whose status
        // changes if anybody derives it from the browser's clock instead of the
        // organisation timezone (trap 1).
        invoiceNumber: "INV-2002",
        currency: "GBP",
        amountMinorUnits: 325_000n,
        dueInDays: 0,
        issuedInDays: -30,
        status: "active",
        description: "Groundworks — phase 2",
        customerReference: "PC-2304",
      },
      {
        // £7,800.00 — 9 days overdue. Bucket: 1-15.
        invoiceNumber: "INV-2003",
        currency: "GBP",
        amountMinorUnits: 780_000n,
        dueInDays: -9,
        issuedInDays: -39,
        status: "active",
        description: "Steel frame supply",
        customerReference: "PC-2255",
      },
      {
        // £1,150.00 — 22 days overdue. Bucket: 16-30.
        invoiceNumber: "INV-2004",
        currency: "GBP",
        amountMinorUnits: 115_000n,
        dueInDays: -22,
        issuedInDays: -52,
        status: "active",
        description: "Site survey and access report",
        customerReference: "PC-2198",
      },
      {
        // £990.00 — chase suspended by hand while a query is resolved. Paused
        // is NOT overdue: derivation only ever applies to Active invoices.
        invoiceNumber: "INV-2005",
        currency: "GBP",
        amountMinorUnits: 99_000n,
        dueInDays: -30,
        issuedInDays: -60,
        status: "paused",
        description: "Plant hire — customer querying the day rate",
        customerReference: "PC-2170",
      },
    ],
  },
  {
    name: "Gulf Interiors LLC",
    email: "ap@gulf-interiors.example",
    reference: "GIL-207",
    paymentTerms: "Net 60",
    behaviour: "Pays in instalments. The reason the payments half of 1.6c exists.",
    contact: {
      name: "Noura Al Hashimi",
      email: "noura.alhashimi@gulf-interiors.example",
      jobTitle: "Accounts Payable Lead",
    },
    invoices: [
      {
        // 10,000.00 AED raised, 6,000.00 AED paid 4 days ago, 4,000.00 LEFT.
        //
        // ⚠️ THE CASE THIS SLICE EXISTS FOR. Before a payment can be recorded,
        // this invoice has no correct state: leave it active and Eva chases the
        // full 10,000, or cancel it and Eva abandons the 4,000 still owed.
        // Eva must chase the BALANCE, never the total.
        invoiceNumber: "INV-3001",
        currency: "AED",
        amountMinorUnits: 1_000_000n,
        amountPaidMinorUnits: 600_000n,
        dueInDays: -12,
        issuedInDays: -72,
        paidInDays: -4,
        status: "partially_paid",
        description: "Fit-out — villa 14, first instalment received",
        customerReference: "GI-5567",
      },
      {
        // 24,500.00 AED — 38 days overdue. Bucket: 31-45.
        invoiceNumber: "INV-3002",
        currency: "AED",
        amountMinorUnits: 2_450_000n,
        dueInDays: -38,
        issuedInDays: -98,
        status: "active",
        description: "Joinery package — villas 9 to 12",
        customerReference: "GI-5488",
      },
      {
        // 500.00 AED invoiced, 525.00 AED received — they OVERPAID by 25.00.
        // Founder ruling: overpayment is allowed and the balance clamps at
        // zero. It must never render as -25.00, which reads as a debt owed the
        // other way (trap 6).
        invoiceNumber: "INV-3003",
        currency: "AED",
        amountMinorUnits: 50_000n,
        amountPaidMinorUnits: 52_500n,
        dueInDays: -25,
        issuedInDays: -85,
        paidInDays: -18,
        status: "paid",
        description: "Snagging visit — overpaid, credit carried",
        customerReference: "GI-5502",
      },
    ],
  },
  {
    name: "Al Mutawa Contracting WLL",
    email: "accounts@almutawa-contracting.example",
    reference: "AMC-032",
    paymentTerms: "Net 45",
    behaviour: "Gone quiet. Nothing paid, nothing said — the escalation case.",
    contact: {
      name: "Yousef Al Mutawa",
      email: "yousef@almutawa-contracting.example",
      jobTitle: "Director",
    },
    invoices: [
      {
        // 12.345 KWD — THREE decimal places.
        //
        // ⚠️ THE REGRESSION CANARY. This exact amount was REJECTED outright as
        // invalid before the money layer merged (`e7967d4`): the old parser
        // capped decimals at two and multiplied by 100. If a screen ever shows
        // this as 12.35, or 1234.5, or refuses it, the ×100 assumption has come
        // back. Kuwait, Bahrain and Oman are three of the six GCC states, and
        // GCC is the stated next market.
        invoiceNumber: "INV-4001",
        currency: "KWD",
        amountMinorUnits: 12_345n,
        dueInDays: -61,
        issuedInDays: -106,
        status: "active",
        description: "Consultancy retainer — small balance, deliberately odd",
        customerReference: "AM-771",
      },
      {
        // 3,750.500 KWD — 47 days overdue. Bucket: >45.
        invoiceNumber: "INV-4002",
        currency: "KWD",
        amountMinorUnits: 3_750_500n,
        dueInDays: -47,
        issuedInDays: -92,
        status: "active",
        description: "Marble supply — phase 1",
        customerReference: "AM-756",
      },
    ],
  },
  {
    name: "Sakura Kikai KK",
    email: "keiri@sakura-kikai.example",
    reference: "SKK-118",
    paymentTerms: "Net 30",
    behaviour: "Zero-decimal currency. Proves nothing divides by 100 on the way out.",
    contact: {
      name: "Aiko Tanaka",
      email: "aiko.tanaka@sakura-kikai.example",
      jobTitle: "Accounting Section",
    },
    invoices: [
      {
        // ¥450,000 — the minor unit IS the yen. NOT 450000 sen, and not
        // ¥4,500.00. A list that formats every currency to two decimals shows
        // this as ¥4,500.00 and is wrong by a factor of a hundred.
        invoiceNumber: "INV-5001",
        currency: "JPY",
        amountMinorUnits: 450_000n,
        dueInDays: -6,
        issuedInDays: -36,
        status: "active",
        description: "Spare parts order — conveyor belts",
        customerReference: "SK-3390",
      },
      {
        // ¥1,280,000 — still a DRAFT, so it is editable and is never chased.
        // The only row in the book that PATCH may touch (trap 4).
        invoiceNumber: "INV-5002",
        currency: "JPY",
        amountMinorUnits: 1_280_000n,
        dueInDays: 10,
        issuedInDays: -20,
        status: "draft",
        description: "Annual maintenance contract — not yet issued",
      },
    ],
  },
];

export interface SeedDemoBookOptions {
  /**
   * Where to put the book. Defaults to the demo organisation.
   *
   * WHY THIS IS A KNOB. The book is only useful if you can SEE it, and
   * `GET /organisations` returns the organisations the signed-in user belongs
   * to. The demo organisation's only members are the two demo users, so signing
   * in locally as yourself shows your OWN organisation with an empty client
   * list, and the book stays invisible. Pointing it at your own organisation is
   * what makes the screens developable against realistic data.
   */
  organisationId?: string;
  /** Who the rows are attributed to. Defaults to the demo owner. */
  createdBy?: string;
  now?: Date;
}

/**
 * Fill an organisation with a realistic book of B2B debtors.
 *
 * Idempotent. Unlike `seed()`, the update branch REWRITES the dates: re-running
 * is how you re-base a book that has aged out from under you, so `update: {}`
 * would defeat the point.
 *
 * ⚠️ ROWS ARE KEYED ON (ORGANISATION, BUSINESS KEY) — a customer's `reference`
 * and an invoice's `invoiceNumber` — NOT on fixed UUIDs. An earlier draft used
 * hard-coded ids, which is fine for one organisation and silently wrong for
 * two: `upsert({ where: { id } })` finds a row wherever it lives, so seeding
 * into a SECOND organisation would have updated the FIRST one's invoices and
 * reported success. The business keys are already unique per organisation
 * (`invoices_organisation_id_invoice_number_key`), so they are the honest key.
 */
export async function seedDemoBook(
  prisma: EvaPrismaClient,
  options: SeedDemoBookOptions | Date = {},
): Promise<void> {
  // A bare Date stays accepted so a caller with only a clock needs no ceremony.
  const opts: SeedDemoBookOptions = options instanceof Date ? { now: options } : options;
  const organisationId = opts.organisationId ?? DEMO_ORGANISATION_ID;
  const createdBy = opts.createdBy ?? DEMO_OWNER_ID;
  const now = opts.now ?? new Date();

  await prisma.$transaction(async (tx) => {
    // FORCE RLS binds the owner role too, so the seed declares its tenant and
    // user context exactly as the application does (BRD 15) — and it means
    // these rows are written through the same policy that guards production.
    await tx.$executeRaw`SELECT set_config('app.current_org', ${organisationId}, true)`;
    await tx.$executeRaw`SELECT set_config('app.current_user', ${createdBy}, true)`;

    // Without the module the invoice screens correctly 402 and there is
    // nothing to look at. Entitlement fails CLOSED, so this has to be explicit.
    //
    // find-then-write rather than upsert: the uniqueness of (organisation,
    // module) is a PARTIAL index — `WHERE deleted_at IS NULL`, so history
    // survives a disable — and Prisma cannot represent a partial index, so no
    // compound unique key exists to upsert on. Same shape as
    // `entitlements.service.ts`.
    const existingModule = await tx.organisationModule.findFirst({
      where: { moduleKey: "email_credit_controller", deletedAt: null },
    });
    if (existingModule) {
      await tx.organisationModule.update({
        where: { id: existingModule.id },
        data: { enabled: true, enabledAt: existingModule.enabledAt ?? now },
      });
    } else {
      await tx.organisationModule.create({
        data: {
          organisationId,
          moduleKey: "email_credit_controller",
          enabled: true,
          source: "manual",
          seats: 1,
          enabledAt: now,
          createdBy,
        },
      });
    }

    for (const customer of DEMO_CUSTOMERS) {
      const customerFields = {
        name: customer.name,
        email: customer.email,
        paymentTerms: customer.paymentTerms,
        // NULL means "chase from the organisation's DEFAULT mailbox" and is the
        // normal state for most of a book (ALLOCATION-SCOPE ruling 1). Nothing
        // stamps a mailbox id onto a client — resolution happens at SEND time,
        // every time (trap 1). Inventing a mailbox here would mean inventing
        // the tokens to go with it.
        emailAccountId: null,
      };

      // `reference` is this customer's stable business key, and keying on it
      // rather than on a fixed id is what makes the write org-scoped.
      const existingCustomer = await tx.customer.findFirst({
        where: { organisationId, reference: customer.reference, deletedAt: null },
      });
      const customerRow = existingCustomer
        ? await tx.customer.update({ where: { id: existingCustomer.id }, data: customerFields })
        : await tx.customer.create({
            data: { organisationId, reference: customer.reference, createdBy, ...customerFields },
          });

      const contactFields = {
        name: customer.contact.name,
        jobTitle: customer.contact.jobTitle,
      };

      const existingContact = await tx.contact.findFirst({
        where: {
          organisationId,
          customerId: customerRow.id,
          email: customer.contact.email,
          deletedAt: null,
        },
      });
      const contactRow = existingContact
        ? await tx.contact.update({ where: { id: existingContact.id }, data: contactFields })
        : await tx.contact.create({
            data: {
              organisationId,
              customerId: customerRow.id,
              email: customer.contact.email,
              createdBy,
              ...contactFields,
            },
          });

      for (const invoice of customer.invoices) {
        const invoiceFields = {
          currency: invoice.currency,
          amountMinorUnits: invoice.amountMinorUnits,
          amountPaidMinorUnits: invoice.amountPaidMinorUnits ?? 0n,
          issueDate: daysFromToday(invoice.issuedInDays, now),
          dueDate: daysFromToday(invoice.dueInDays, now),
          lastPaymentAt:
            invoice.paidInDays === undefined ? null : daysFromToday(invoice.paidInDays, now),
          status: invoice.status,
          description: invoice.description,
          customerReference: invoice.customerReference ?? null,
          paymentTerms: customer.paymentTerms,
        };

        // `invoice_number` is unique per organisation among live rows
        // (`invoices_organisation_id_invoice_number_key`), so it is the key.
        const existingInvoice = await tx.invoice.findFirst({
          where: { organisationId, invoiceNumber: invoice.invoiceNumber, deletedAt: null },
        });
        if (existingInvoice) {
          await tx.invoice.update({ where: { id: existingInvoice.id }, data: invoiceFields });
        } else {
          await tx.invoice.create({
            data: {
              organisationId,
              customerId: customerRow.id,
              contactId: contactRow.id,
              invoiceNumber: invoice.invoiceNumber,
              createdBy,
              ...invoiceFields,
            },
          });
        }
      }
    }
  });
}

/** Row counts, for the CLI to report and the spec to assert against. */
export const DEMO_BOOK_SIZE = {
  customers: DEMO_CUSTOMERS.length,
  invoices: DEMO_CUSTOMERS.reduce((total, customer) => total + customer.invoices.length, 0),
} as const;

export { DEMO_CUSTOMERS };
