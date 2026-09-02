import type { ProductManifest } from "../platform/registry/product-manifest.js";
import { INVOICE_FOLLOW_UP } from "./invoice-follow-up/product.js";
import { LEAD_FOLLOW_UP } from "./lead-follow-up/product.js";

/**
 * ⚠️ THE REGISTRATION LINE. This is the composition root for products, and the
 * ONE place that knows which products exist.
 *
 * It lives here rather than in `platform/` deliberately: the platform must
 * never import a product (BRD §3.1.2, enforced by `pnpm boundaries`). A
 * composition root is allowed to know both sides — that is its entire job — so
 * the dependency arrow still points inward everywhere that matters.
 *
 * **Adding a product is a folder, a `product.ts`, and one line here.** If
 * adding one ever requires editing anything under `platform/`, the boundary has
 * been broken and the CRM will cost a foundation instead of a folder.
 */
export const PRODUCT_MANIFESTS: readonly ProductManifest[] = [
  INVOICE_FOLLOW_UP,
  /**
   * Slice 3.1c-1, and the first time this list has had more than one entry —
   * which is the moment every rule in `architecture.spec.ts` stops being
   * theoretical. "A product's tables are touched ONLY by that product" was
   * written when it was trivially true; it now has something to catch.
   */
  LEAD_FOLLOW_UP,
];
