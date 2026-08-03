import { createPrismaClient } from "./client.js";
import { DEMO_BOOK_SIZE, seedDemoBook } from "./demo-book.js";
import { isLocalDatabase } from "./seed-cli-guard.js";
import { seed } from "./seed.js";

const DEFAULT_LOCAL_URL = "postgresql://eva:eva@localhost:5432/eva";
const connectionString = process.env.DATABASE_URL ?? DEFAULT_LOCAL_URL;

const prisma = createPrismaClient(connectionString);

try {
  // Roles are a global lookup table that every environment needs, so the
  // Phase 0 seed always runs. Only the demo BOOK is local-only.
  await seed(prisma);
  console.log("Seed complete — demo organisation is flagged is_demo (BRD 18.6).");

  if (isLocalDatabase(connectionString)) {
    /**
     * `DEMO_BOOK_ORG_ID` puts the book somewhere you can actually SEE it.
     *
     * By default it lands in the demo organisation, whose only members are the
     * two demo users — so signing in locally as yourself shows YOUR
     * organisation, with an empty client list, and none of this is visible.
     * Set this to your own local organisation id to develop the screens against
     * it:
     *
     *   $env:DEMO_BOOK_ORG_ID="<your org id>"; pnpm db:seed
     */
    const organisationId = process.env.DEMO_BOOK_ORG_ID;
    await seedDemoBook(prisma, { ...(organisationId ? { organisationId } : {}) });
    console.log(
      `Demo book seeded — ${String(DEMO_BOOK_SIZE.customers)} clients, ` +
        `${String(DEMO_BOOK_SIZE.invoices)} invoices across GBP/AED/KWD/JPY, ` +
        `into ${organisationId ?? "the demo organisation"}. ` +
        "Dates are relative to today; re-run to re-base the ageing.",
    );
    if (organisationId) {
      // Worth saying out loud: outside the demo organisation the rows lose the
      // `is_demo` send-exclusion (BRD 18.6), so the local-only guard above is
      // the ONLY thing keeping invented debtors away from a real send path.
      console.warn(
        "Note: that organisation is not flagged is_demo, so these rows are not " +
          "excluded from send paths. Local databases only — never point this at cloud.",
      );
    }
  } else {
    // Say WHY, and say it loudly. A silent skip looks identical to a seeder
    // that ran and did nothing, and someone would go looking for the bug.
    console.warn(
      "Demo book SKIPPED — DATABASE_URL is not local. " +
        "The book is invented companies and must never reach a real database.",
    );
  }
} finally {
  await prisma.$disconnect();
}
