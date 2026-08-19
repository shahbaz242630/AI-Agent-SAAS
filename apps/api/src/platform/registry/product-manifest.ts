import type { ModuleKey } from "@eva/types";

/**
 * What a product declares about itself (BRD §3.1.1, §8).
 *
 * ⚠️ THIS IS THE SHAPE, NOT A LIST OF PRODUCTS. The platform must never import
 * a product — a base that knows the names of the things plugged into it is not
 * a base, and the CRM would mean editing the foundation rather than adding a
 * folder. The concrete manifests are collected at the composition root
 * (`src/products/index.ts`), which is allowed to know them because that is what
 * a composition root is for.
 *
 * Adding a product is: a folder, a `product.ts` exporting one of these, and one
 * line in that index.
 */
export interface ProductManifest {
  /** The entitlement key. Must be one of `MODULE_KEYS`. */
  readonly key: ModuleKey;
  /**
   * The Prisma model accessors this product OWNS — the camelCase names used in
   * code (`tx.invoice`, `tx.scheduledAction`), not the SQL table names.
   *
   * ⚠️ OWNERSHIP IS EXCLUSIVE. No other product may read or write these, and
   * `architecture.spec.ts` fails if one does. Where a product must react to
   * another, it subscribes to a domain event.
   */
  readonly tables: readonly string[];
}
