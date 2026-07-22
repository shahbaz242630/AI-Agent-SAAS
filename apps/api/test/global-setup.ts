import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { TEST_OWNER_DATABASE_URL } from "./support.js";

const require = createRequire(path.join(process.cwd(), "package.json"));
// The Prisma CLI is a devDependency of @eva/database; resolve it through that
// package (pnpm's isolated node_modules blocks a direct resolve from here).
const databaseRoot = path.resolve(path.dirname(require.resolve("@eva/database")), "..");
const prismaCli = path.join(databaseRoot, "node_modules", "prisma", "build", "index.js");

/**
 * Applies all migrations to the test database before any spec runs, so the
 * API specs can also run standalone (same pattern as @eva/database).
 */
export default function globalSetup(): void {
  execFileSync(process.execPath, [prismaCli, "migrate", "deploy"], {
    cwd: databaseRoot,
    env: { ...process.env, DATABASE_URL: TEST_OWNER_DATABASE_URL },
    stdio: "inherit",
  });
}
