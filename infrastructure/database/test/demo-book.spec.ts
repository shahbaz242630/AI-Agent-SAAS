import { formatMinorUnits, minorUnitDigits, outstandingBalance } from "@eva/types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient, type EvaPrismaClient } from "../src/client.js";
import { DEMO_BOOK_SIZE, DEMO_CUSTOMERS, seedDemoBook } from "../src/demo-book.js";
import { isLocalDatabase } from "../src/seed-cli-guard.js";
import { DEMO_ORGANISATION_ID, seed } from "../src/seed.js";
import { TEST_DATABASE_URL } from "./support.js";

const ALL_INVOICES = DEMO_CUSTOMERS.flatMap((customer) => customer.invoices);

function invoice(invoiceNumber: string) {
  const found = ALL_INVOICES.find((row) => row.invoiceNumber === invoiceNumber);
  if (!found) throw new Error(`Demo book has no ${invoiceNumber}`);
  return found;
}

/**
 * ⚠️ THE POINT OF THIS FILE.
 *
 * `demo-book.ts` states every amount as a LITERAL number of minor units, with
 * the human-readable amount in a comment. That is deliberate — a fixture that
 * calls the parser to build itself agrees with the parser even when both are
 * wrong. These tests are the other half of that bargain: they push the literals
 * through the REAL money helper and assert what a human should see. If the
 * literal and the comment ever drift apart, this fails.
 */
describe("demo book — the literal amounts mean what the comments say", () => {
  it("shows a three-decimal Kuwaiti invoice as 12.345, not 12.35 and not 1234.5", () => {
    // The exact amount the pre-1.6c parser REJECTED as invalid, because it
    // capped decimals at two and multiplied by 100. This row is the canary: if
    // the ×100 assumption ever comes back, it moves by a factor of ten.
    const kuwaiti = invoice("INV-4001");
    expect(kuwaiti.currency).toBe("KWD");
    expect(formatMinorUnits(kuwaiti.amountMinorUnits, kuwaiti.currency)).toBe("12.345");
  });

  it("shows a zero-decimal Japanese invoice as 450000 yen, not 4500.00", () => {
    const japanese = invoice("INV-5001");
    expect(japanese.currency).toBe("JPY");
    expect(formatMinorUnits(japanese.amountMinorUnits, japanese.currency)).toBe("450000");
  });

  it("shows a two-decimal invoice normally", () => {
    const emirati = invoice("INV-3002");
    expect(formatMinorUnits(emirati.amountMinorUnits, emirati.currency)).toBe("24500.00");
  });

  it("leaves 4,000.00 AED outstanding on the part-paid invoice", () => {
    // The case the payments half of slice 1.6c exists for: 10,000 raised,
    // 6,000 received, and Eva must chase 4,000 — not 10,000, and not nothing.
    const partPaid = invoice("INV-3001");
    expect(partPaid.status).toBe("partially_paid");
    expect(formatMinorUnits(partPaid.amountMinorUnits, partPaid.currency)).toBe("10000.00");
    expect(formatMinorUnits(partPaid.amountPaidMinorUnits!, partPaid.currency)).toBe("6000.00");
    const balance = outstandingBalance(partPaid.amountMinorUnits, partPaid.amountPaidMinorUnits!);
    expect(formatMinorUnits(balance, partPaid.currency)).toBe("4000.00");
  });

  it("clamps the overpaid invoice's balance at zero rather than showing a negative", () => {
    // Founder ruling: overpayment is allowed. A -25.00 balance reads as a debt
    // owed the other way, which would have Eva chasing a credit (trap 6).
    const overpaid = invoice("INV-3003");
    expect(overpaid.amountPaidMinorUnits!).toBeGreaterThan(overpaid.amountMinorUnits);
    const balance = outstandingBalance(overpaid.amountMinorUnits, overpaid.amountPaidMinorUnits!);
    expect(balance).toBe(0n);
    expect(formatMinorUnits(balance, overpaid.currency)).toBe("0.00");
  });
});

describe("demo book — coverage that stops the screens being developed against easy data", () => {
  it("spans all three ISO 4217 exponent groups", () => {
    // A book of one exponent renders perfectly while hiding the defect this
    // slice exists to prevent. If someone ever "tidies" the book down to GBP,
    // this fails and says why.
    const digits = new Set(ALL_INVOICES.map((row) => minorUnitDigits(row.currency)));
    expect([...digits].sort()).toEqual([0, 2, 3]);
  });

  it("holds more than one currency, so no honest screen can sum the book", () => {
    // Trap 3b: currency is per invoice, so an org-wide total is meaningless
    // unless it groups. Adding AED to GBP gives a confident wrong number.
    const currencies = new Set(ALL_INVOICES.map((row) => row.currency));
    expect(currencies.size).toBeGreaterThan(1);
  });

  it("reaches all four display statuses through its ACTIVE invoices", () => {
    // Derivation only ever applies to Active invoices, so only those can
    // produce overdue / due_today / due_soon (invoice-status.ts).
    const active = ALL_INVOICES.filter((row) => row.status === "active");
    expect(
      active.some((row) => row.dueInDays < 0),
      "overdue",
    ).toBe(true);
    expect(
      active.some((row) => row.dueInDays === 0),
      "due_today",
    ).toBe(true);
    expect(
      active.some((row) => row.dueInDays > 0 && row.dueInDays <= 3),
      "due_soon",
    ).toBe(true);
    expect(
      active.some((row) => row.dueInDays > 3),
      "plain active",
    ).toBe(true);
  });

  it("puts an invoice in every ageing bucket", () => {
    // Current · 1-15 · 16-30 · 31-45 · >45 (DATA-MODEL-REVIEW §4). If they all
    // landed in one bucket the org-wide screen would look right while being
    // untested.
    const chaseable = ALL_INVOICES.filter(
      (row) => row.status === "active" || row.status === "partially_paid",
    );
    const overdueDays = chaseable.map((row) => -row.dueInDays);
    expect(
      overdueDays.some((d) => d <= 0),
      "Current",
    ).toBe(true);
    expect(
      overdueDays.some((d) => d >= 1 && d <= 15),
      "1-15",
    ).toBe(true);
    expect(
      overdueDays.some((d) => d >= 16 && d <= 30),
      "16-30",
    ).toBe(true);
    expect(
      overdueDays.some((d) => d >= 31 && d <= 45),
      "31-45",
    ).toBe(true);
    expect(
      overdueDays.some((d) => d > 45),
      ">45",
    ).toBe(true);
  });

  it("seeds only statuses the product can actually produce", () => {
    // promise_to_pay / disputed / written_off are slice 1.8. Seeding a state
    // nothing can reach invites a screen that pretends it can.
    const statuses = new Set(ALL_INVOICES.map((row) => row.status));
    expect(statuses).not.toContain("promise_to_pay");
    expect(statuses).not.toContain("disputed");
    expect(statuses).not.toContain("written_off");
    expect(statuses).toContain("draft");
    expect(statuses).toContain("paused");
    expect(statuses).toContain("cancelled");
  });

  it("keeps every paid figure consistent with its status and its payment date", () => {
    for (const row of ALL_INVOICES) {
      const paid = row.amountPaidMinorUnits ?? 0n;
      expect(row.amountMinorUnits, `${row.invoiceNumber} amount > 0`).toBeGreaterThan(0n);
      expect(paid, `${row.invoiceNumber} paid >= 0`).toBeGreaterThanOrEqual(0n);

      if (row.status === "partially_paid") {
        expect(paid, `${row.invoiceNumber} part paid`).toBeGreaterThan(0n);
        expect(paid, `${row.invoiceNumber} part paid`).toBeLessThan(row.amountMinorUnits);
      }
      if (row.status === "paid") {
        expect(paid, `${row.invoiceNumber} paid in full`).toBeGreaterThanOrEqual(
          row.amountMinorUnits,
        );
      }
      // A payment date without a payment (or the reverse) is the kind of
      // inconsistency that makes DSO quietly wrong.
      expect(
        row.paidInDays !== undefined,
        `${row.invoiceNumber} payment date matches payment`,
      ).toBe(paid > 0n);
      // Nothing may be invoiced after it was due, or paid before it existed.
      expect(row.issuedInDays, `${row.invoiceNumber} issued before due`).toBeLessThan(
        row.dueInDays,
      );
      if (row.paidInDays !== undefined) {
        expect(row.paidInDays, `${row.invoiceNumber} paid after issue`).toBeGreaterThan(
          row.issuedInDays,
        );
      }
    }
  });

  it("gives every invoice a unique number", () => {
    const numbers = ALL_INVOICES.map((row) => row.invoiceNumber);
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it("gives every row a unique business key, because that is what identifies it", () => {
    // Rows are keyed on (organisation, reference) and (organisation,
    // invoiceNumber) rather than on fixed UUIDs — see the note on
    // `seedDemoBook`. A duplicate key would silently make one row overwrite
    // another on re-seed, so uniqueness here is load-bearing, not cosmetic.
    const references = DEMO_CUSTOMERS.map((c) => c.reference);
    expect(new Set(references).size).toBe(references.length);
    const contactEmails = DEMO_CUSTOMERS.map((c) => c.contact.email);
    expect(new Set(contactEmails).size).toBe(contactEmails.length);
  });
});

describe("the local-only guard", () => {
  it("allows a database on this machine", () => {
    expect(isLocalDatabase("postgresql://eva:eva@localhost:5432/eva")).toBe(true);
    expect(isLocalDatabase("postgresql://eva:eva@127.0.0.1:5432/eva")).toBe(true);
    expect(isLocalDatabase("postgresql://eva:eva@[::1]:5432/eva")).toBe(true);
  });

  it("REFUSES the shapes our own cloud database actually takes", () => {
    // These are the strings that would do real damage: fifteen invented
    // companies landing next to a real organisation's invoices, and — once 1.7
    // can send — invented debtors in a database wired to a real mailbox.
    expect(
      isLocalDatabase("postgresql://postgres:pw@db.abcdefghijklm.supabase.co:5432/postgres"),
    ).toBe(false);
    expect(
      isLocalDatabase(
        "postgresql://postgres.abc:pw@aws-0-eu-west-2.pooler.supabase.com:6543/postgres",
      ),
    ).toBe(false);
    expect(
      isLocalDatabase("postgresql://eva:pw@containers-us-west-1.railway.app:7432/railway"),
    ).toBe(false);
  });

  it("fails CLOSED on anything it cannot make sense of", () => {
    // A guard that waves through what it does not recognise is not a guard.
    expect(isLocalDatabase("")).toBe(false);
    expect(isLocalDatabase("not a url")).toBe(false);
    expect(isLocalDatabase("localhost:5432/eva")).toBe(false);
  });

  it("is not fooled by a hostname that merely contains 'localhost'", () => {
    expect(isLocalDatabase("postgresql://eva:pw@localhost.evil.example:5432/eva")).toBe(false);
    expect(isLocalDatabase("postgresql://eva:pw@notlocalhost:5432/eva")).toBe(false);
  });
});

describe("demo book — against a real database", () => {
  let prisma: EvaPrismaClient;

  beforeAll(async () => {
    prisma = createPrismaClient(TEST_DATABASE_URL);
    await seed(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  /**
   * ⚠️ EVERY QUERY BELOW IS SCOPED TO THE BOOK'S OWN ROWS, never to "everything
   * in the demo organisation".
   *
   * `tenant.spec.ts` also writes customers into DEMO_ORGANISATION_ID, and
   * vitest runs spec FILES in parallel against one database. A count of the
   * whole organisation therefore counts another spec's rows, and how many it
   * finds depends on which file happens to be mid-flight — so the assertion
   * passes or fails on timing rather than on this seeder. The first draft of
   * this file did exactly that and reported 7 customers for a book of 5.
   *
   * This is the same trap slice 1.6b recorded: eight resolver tests silently
   * resolved against other spec files' organisations.
   */
  const BOOK_REFERENCES = DEMO_CUSTOMERS.map((customer) => customer.reference);
  const BOOK_CONTACT_EMAILS = DEMO_CUSTOMERS.map((customer) => customer.contact.email);
  const BOOK_INVOICE_NUMBERS = ALL_INVOICES.map((row) => row.invoiceNumber);

  async function demoCounts(): Promise<Record<string, number>> {
    const organisationId = DEMO_ORGANISATION_ID;
    return {
      customers: await prisma.customer.count({
        where: { organisationId, reference: { in: BOOK_REFERENCES } },
      }),
      contacts: await prisma.contact.count({
        where: { organisationId, email: { in: BOOK_CONTACT_EMAILS } },
      }),
      // By invoice NUMBER rather than by id, so a second seed that created
      // rows instead of upserting them would show up as a higher count rather
      // than being invisible.
      invoices: await prisma.invoice.count({
        where: { organisationId, invoiceNumber: { in: BOOK_INVOICE_NUMBERS } },
      }),
    };
  }

  it("writes the whole book", async () => {
    await seedDemoBook(prisma);
    const counts = await demoCounts();
    expect(counts.customers).toBe(DEMO_BOOK_SIZE.customers);
    expect(counts.contacts).toBe(DEMO_BOOK_SIZE.customers);
    expect(counts.invoices).toBe(DEMO_BOOK_SIZE.invoices);
  });

  it("enables the email credit controller, or every invoice screen 402s", async () => {
    await seedDemoBook(prisma);
    const module = await prisma.organisationModule.findFirst({
      where: {
        organisationId: DEMO_ORGANISATION_ID,
        moduleKey: "email_credit_controller",
        deletedAt: null,
      },
    });
    expect(module?.enabled).toBe(true);
  });

  it("is idempotent — seeding twice changes no row counts", async () => {
    await seedDemoBook(prisma);
    const before = await demoCounts();
    await seedDemoBook(prisma);
    expect(await demoCounts()).toEqual(before);
  });

  it("RE-BASES the ageing when it runs again, instead of letting the book drift", async () => {
    // The design property that makes this fixture worth having. A book with
    // FIXED dates rots: a row seeded 38 days overdue is 68 days overdue a month
    // later, so it silently changes ageing bucket and the screen you thought you
    // were exercising is exercising something else.
    //
    // This test would fail against hard-coded dates, and against an
    // `update: {}` upsert that leaves existing rows alone.
    const day = 86_400_000;
    const first = new Date("2026-06-01T09:00:00.000Z");
    const later = new Date(first.getTime() + 10 * day);

    await seedDemoBook(prisma, first);
    const before = await prisma.invoice.findFirstOrThrow({
      where: { organisationId: DEMO_ORGANISATION_ID, invoiceNumber: "INV-3002" },
    });

    await seedDemoBook(prisma, later);
    const after = await prisma.invoice.findFirstOrThrow({
      where: { organisationId: DEMO_ORGANISATION_ID, invoiceNumber: "INV-3002" },
    });

    expect(after.dueDate.getTime() - before.dueDate.getTime()).toBe(10 * day);
    expect(after.issueDate.getTime() - before.issueDate.getTime()).toBe(10 * day);
  });

  it("stores dates at UTC midnight, so no row tips onto the neighbouring day", async () => {
    // Seeded from a time late enough in the day that a local-time conversion
    // would land on the wrong date in any timezone east of UTC.
    await seedDemoBook(prisma, new Date("2026-06-01T23:30:00.000Z"));
    const rows = await prisma.invoice.findMany({
      where: {
        organisationId: DEMO_ORGANISATION_ID,
        invoiceNumber: { in: BOOK_INVOICE_NUMBERS },
      },
    });
    for (const row of rows) {
      expect(row.dueDate.getUTCHours(), `${row.invoiceNumber} due`).toBe(0);
      expect(row.issueDate.getUTCHours(), `${row.invoiceNumber} issue`).toBe(0);
    }
  });

  it("leaves every client unfiled, which is the normal state", async () => {
    // ALLOCATION-SCOPE ruling 1: NULL means "chase from the default mailbox",
    // not "do not chase". Stamping a mailbox id here would bake in trap 1.
    await seedDemoBook(prisma);
    const filed = await prisma.customer.count({
      where: {
        organisationId: DEMO_ORGANISATION_ID,
        reference: { in: BOOK_REFERENCES },
        emailAccountId: { not: null },
      },
    });
    expect(filed).toBe(0);
  });

  it("seeds a SECOND organisation without touching the first", async () => {
    /**
     * ⚠️ THE BUG THIS TEST EXISTS FOR, found by asking where the book was
     * actually visible from.
     *
     * The first draft keyed every row on a hard-coded UUID. `upsert({ where:
     * { id } })` finds a row wherever it lives, and `update` did not set
     * `organisationId` — so seeding into a second organisation would have
     * quietly UPDATED the first organisation's invoices, left the second
     * empty, and printed "seeded" either way.
     *
     * Keyed on (organisation, business key) the two books are independent.
     */
    const otherOrgId = "00000000-0000-4000-8000-0000000000bb";
    await prisma.organisation.upsert({
      where: { id: otherOrgId },
      update: {},
      create: { id: otherOrgId, name: "Second Org Ltd", isDemo: true },
    });

    await seedDemoBook(prisma, { organisationId: DEMO_ORGANISATION_ID });
    const firstBefore = await prisma.invoice.findFirstOrThrow({
      where: { organisationId: DEMO_ORGANISATION_ID, invoiceNumber: "INV-3001" },
    });

    await seedDemoBook(prisma, { organisationId: otherOrgId });

    // The second organisation got its own copy...
    const second = await prisma.invoice.count({
      where: { organisationId: otherOrgId, invoiceNumber: { in: BOOK_INVOICE_NUMBERS } },
    });
    expect(second).toBe(DEMO_BOOK_SIZE.invoices);

    // ...and the first organisation still has its own, unmoved.
    const firstAfter = await prisma.invoice.findFirstOrThrow({
      where: { organisationId: DEMO_ORGANISATION_ID, invoiceNumber: "INV-3001" },
    });
    expect(firstAfter.id).toBe(firstBefore.id);
    expect(
      await prisma.invoice.count({
        where: {
          organisationId: DEMO_ORGANISATION_ID,
          invoiceNumber: { in: BOOK_INVOICE_NUMBERS },
        },
      }),
    ).toBe(DEMO_BOOK_SIZE.invoices);

    // Clients too — a customer must not have been dragged across tenants.
    expect(
      await prisma.customer.count({
        where: { organisationId: otherOrgId, reference: { in: BOOK_REFERENCES } },
      }),
    ).toBe(DEMO_BOOK_SIZE.customers);
    expect(
      await prisma.customer.count({
        where: { organisationId: DEMO_ORGANISATION_ID, reference: { in: BOOK_REFERENCES } },
      }),
    ).toBe(DEMO_BOOK_SIZE.customers);
  });

  it("satisfies the database's own money and status constraints", async () => {
    // The literals above are checked against the money helper; this checks them
    // against Postgres, which is the thing that actually refuses bad data.
    await seedDemoBook(prisma);
    const rows = await prisma.invoice.findMany({
      where: {
        organisationId: DEMO_ORGANISATION_ID,
        invoiceNumber: { in: BOOK_INVOICE_NUMBERS },
      },
    });
    expect(rows).toHaveLength(DEMO_BOOK_SIZE.invoices);
    for (const row of rows) {
      expect(row.amountMinorUnits, row.invoiceNumber).toBeGreaterThan(0n);
      expect(row.amountPaidMinorUnits, row.invoiceNumber).toBeGreaterThanOrEqual(0n);
    }
  });
});
