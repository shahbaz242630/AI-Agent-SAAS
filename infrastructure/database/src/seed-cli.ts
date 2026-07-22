import { createPrismaClient } from "./client.js";
import { seed } from "./seed.js";

const connectionString = process.env.DATABASE_URL ?? "postgresql://eva:eva@localhost:5432/eva";
const prisma = createPrismaClient(connectionString);

try {
  await seed(prisma);
  console.log("Seed complete — demo organisation is flagged is_demo (BRD 18.6).");
} finally {
  await prisma.$disconnect();
}
