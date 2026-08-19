import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MODULE_KEYS } from "@eva/types";
import { PRODUCT_MANIFESTS } from "../src/products/index.js";
import {
  ALLOWED_CROSSINGS,
  CAPABILITY_TABLES,
  PLATFORM_TABLES,
} from "../src/platform/registry/table-ownership.js";

/**
 * The platform/product boundary, in the half `pnpm boundaries` cannot see.
 *
 * ⚠️ TWO WALLS, TWO MECHANISMS, AND NEITHER COVERS THE OTHER.
 * `dependency-cruiser` reads import statements, so it catches a product
 * importing another product's code. It is blind to the database: Prisma is one
 * shared client, so `tx.invoice.findMany()` from inside the platform is
 * indistinguishable from any other data access. **A boundary crossed through
 * the database is invisible to the import rules.** This file is the wall for
 * that half.
 *
 * Founder ruling 2026-08-19: products are plug-and-play so that one can be
 * debugged, changed and switched off without disturbing another.
 */

const SRC = path.resolve(__dirname, "../src");

/** Every non-spec .ts file under src, as { layer, path, source }. */
function sourceFiles(): { layer: string; file: string; source: string }[] {
  const out: { layer: string; file: string; source: string }[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry === "node_modules" || entry === "dist" || entry === "generated") continue;
        walk(full);
        continue;
      }
      if (!entry.endsWith(".ts") || entry.endsWith(".spec.ts")) continue;
      const rel = path.relative(SRC, full).split(path.sep).join("/");
      /**
       * The layer is the first two path segments — `platform/entitlements`,
       * `products/invoice-follow-up`, `capabilities/mailbox`. Files sitting
       * directly in src (`app.module.ts`, `main.ts`) are the composition root
       * and are allowed to know everything; that is what a root is.
       */
      const parts = rel.split("/");
      if (parts.length < 3) continue;
      out.push({ layer: `${parts[0]}/${parts[1]}`, file: rel, source: readFileSync(full, "utf8") });
    }
  };
  walk(SRC);
  return out;
}

/**
 * Comments stripped before scanning.
 *
 * ⚠️ THIS WAS A REAL FALSE POSITIVE, NOT A PRECAUTION. The first run of this
 * spec failed on `table-ownership.ts`, whose doc comment *explains the rule* by
 * quoting `tx.invoice.findMany()` as the example of what is invisible to the
 * import checker. A detector that cannot tell code from prose reports the
 * documentation of a rule as a violation of it. `//` preceded by `:` is spared
 * so URLs survive.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** `tx.invoice.` / `this.prisma.db.customer.` / `client.user.` → the model name. */
function tablesUsedIn(rawSource: string, tables: readonly string[]): string[] {
  const source = stripComments(rawSource);
  return tables.filter((table) =>
    new RegExp(
      `\\.${table}\\.(findMany|findFirst|findUnique|create|update|upsert|delete|count|aggregate|groupBy|findFirstOrThrow|findUniqueOrThrow|updateMany|deleteMany|createMany)\\b`,
    ).test(source),
  );
}

describe("Architecture: the platform/product boundary", () => {
  const files = sourceFiles();
  const productTables = new Map<string, string>(); // table -> owning product key
  for (const manifest of PRODUCT_MANIFESTS) {
    for (const table of manifest.tables) productTables.set(table, manifest.key);
  }

  it("every product manifest names a real product", () => {
    expect(PRODUCT_MANIFESTS.length).toBeGreaterThan(0);
    for (const manifest of PRODUCT_MANIFESTS) {
      expect(MODULE_KEYS, `${manifest.key} is not a product`).toContain(manifest.key);
      expect(manifest.tables.length, `${manifest.key} owns no tables`).toBeGreaterThan(0);
    }
  });

  it("no table is owned twice", () => {
    const seen = new Set<string>();
    const all = [
      ...PLATFORM_TABLES,
      ...Object.values(CAPABILITY_TABLES).flat(),
      ...PRODUCT_MANIFESTS.flatMap((m) => m.tables),
    ];
    for (const table of all) {
      expect(seen.has(table), `${table} is claimed by two owners`).toBe(false);
      seen.add(table);
    }
  });

  /**
   * ⚠️ THE ONE THAT MATTERS WHEN THE SECOND PRODUCT LANDS.
   *
   * Trivially true today — there is one product. It is written now, before lead
   * follow-up exists, because a rule added after the violation is a rule that
   * has already cost something. When lead follow-up reads `tx.invoice`, this
   * fails and names the file.
   */
  it("a product's tables are touched ONLY by that product", () => {
    const violations: string[] = [];
    for (const { layer, file, source } of files) {
      for (const table of tablesUsedIn(source, [...productTables.keys()])) {
        const owner = productTables.get(table)!;
        const ownerLayer = PRODUCT_MANIFESTS.find((m) => m.key === owner);
        const isOwningProduct =
          layer.startsWith("products/") &&
          PRODUCT_MANIFESTS.some((m) => m === ownerLayer && layer === productLayerOf(m.key));
        if (!isOwningProduct) violations.push(`${file} reads '${table}', owned by ${owner}`);
      }
    }
    expect(violations).toEqual([]);
  });

  /**
   * The platform is the shared base, so every layer may read its tables — that
   * is what a base is for. Capability tables are different: they belong to
   * machinery, and the platform reaching into them points the dependency
   * backwards. Those crossings are listed in `ALLOWED_CROSSINGS` with a reason.
   *
   * ⚠️ THIS TEST EXISTS TO STOP THAT LIST GROWING QUIETLY. An undeclared
   * crossing fails; adding one means writing down why, where a reviewer sees it.
   */
  it("capability tables are read only by their capability, or by a declared exception", () => {
    const capabilityTables = Object.entries(CAPABILITY_TABLES).flatMap(([capability, tables]) =>
      tables.map((table) => ({ capability, table })),
    );
    const violations: string[] = [];
    for (const { layer, file, source } of files) {
      for (const { capability, table } of capabilityTables) {
        if (!tablesUsedIn(source, [table]).length) continue;
        if (layer === `capabilities/${capability}`) continue;
        if (layer.startsWith("products/")) continue; // products may use machinery they pay for
        if (ALLOWED_CROSSINGS.some((c) => c.layer === layer && c.table === table)) continue;
        violations.push(`${file} (${layer}) reads capability table '${table}'`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("every declared crossing explains itself", () => {
    for (const crossing of ALLOWED_CROSSINGS) {
      expect(
        crossing.why.length,
        `${crossing.layer} → ${crossing.table} has no reason`,
      ).toBeGreaterThan(20);
    }
  });

  /** No product folder may exist without a manifest — otherwise it owns nothing,
   *  and nothing stops another product reading its tables. */
  it("every product folder is registered", () => {
    const folders = readdirSync(path.join(SRC, "products")).filter((entry) =>
      statSync(path.join(SRC, "products", entry)).isDirectory(),
    );
    expect(folders.sort()).toEqual(PRODUCT_MANIFESTS.map((m) => productFolderOf(m.key)).sort());
  });
});

/** Folder name for a product key. The one place the two vocabularies meet. */
function productFolderOf(key: string): string {
  const folders: Record<string, string> = {
    email_credit_controller: "invoice-follow-up",
    lead_follow_up_agent: "lead-follow-up",
    voice_credit_controller: "voice-follow-up",
    ai_receptionist: "receptionist",
  };
  return folders[key] ?? key;
}

function productLayerOf(key: string): string {
  return `products/${productFolderOf(key)}`;
}
