import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TEST_DATABASE_URL } from "./support.js";

const packageRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

// Invoke the Prisma CLI's JS entry directly with the current Node binary —
// spawning pnpm.cmd/prisma.cmd without a shell is blocked on Windows.
const require = createRequire(import.meta.url);
const prismaCli = require.resolve("prisma/build/index.js");

/**
 * Applies all migrations to the (fresh) test database before any spec runs.
 * This doubles as the "migrations apply cleanly to an empty database" check —
 * if `prisma migrate deploy` fails here, every test fails.
 */
export default function globalSetup(): void {
  execFileSync(process.execPath, [prismaCli, "migrate", "deploy"], {
    cwd: packageRoot,
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    stdio: "inherit",
  });
}
