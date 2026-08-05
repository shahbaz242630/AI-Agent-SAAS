import { fileURLToPath } from "node:url";
import { defineTestConfig } from "@eva/testing";

/**
 * The `@/*` alias from `tsconfig.json` has to be repeated here — TypeScript's
 * `paths` are a type-checking concern and Vitest resolves modules itself.
 *
 * Without it a spec can only import `@/…` modules it also MOCKS, because the
 * mock factory satisfies the specifier and the alias is never resolved. That
 * held until slice 1.6c, where `createInvoice` imports the real `@/lib/money`
 * to convert an amount — and testing that conversion for real is the whole
 * point, since it is where a `* 100` would do its damage.
 */
export default defineTestConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
