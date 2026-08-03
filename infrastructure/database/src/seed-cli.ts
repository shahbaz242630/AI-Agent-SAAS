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
    await seedDemoBook(prisma);
    console.log(
      `Demo book seeded — ${String(DEMO_BOOK_SIZE.customers)} clients, ` +
        `${String(DEMO_BOOK_SIZE.invoices)} invoices across GBP/AED/KWD/JPY. ` +
        "Dates are relative to today; re-run to re-base the ageing.",
    );
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
