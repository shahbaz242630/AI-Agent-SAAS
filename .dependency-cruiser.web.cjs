/**
 * Architecture boundaries for the WEB app (BRD §3.1.2 and §8; AGENTS.md A1–A7).
 *
 * ⚠️ WHY THIS FILE EXISTS AS A SECOND CONFIG, AND NOT AS MORE RULES IN THE
 * FIRST ONE. `.dependency-cruiser.cjs` guards `apps/api`, whose imports are
 * relative and need no path aliases. The web app imports through `@/…`, which
 * only resolves with `tsConfig` pointed at `apps/web/tsconfig.json` — and
 * dependency-cruiser takes ONE tsConfig per run. Two configs, two runs, both
 * wired into `pnpm boundaries`.
 *
 * ⚠️ THE GAP THIS CLOSES (found by audit, 2026-08-19). The API was split into
 * platform / capabilities / products with two walls around it. The web app was
 * not. Its ROUTES were separated (`/app/invoice-chasing/…`) but its CODE was
 * not: eight invoice-domain modules sat in the shared `src/lib/` beside
 * genuinely generic ones. That is the same defect as `ledger.ts` in the API's
 * `common/` — invoice domain in the shared kernel, where the next product
 * inherits it — except here nothing would have failed the build.
 *
 * The layers, mirroring the API:
 *
 *   src/products/<product>/   self-contained product logic. Invoice follow-up
 *                             today; lead follow-up next.
 *   src/capabilities/<cap>/   shared machinery (mailbox). Not sold on its own.
 *   src/lib/                  the shared kernel: session, api client, money,
 *                             navigation, permissions. NO product meaning.
 *   src/app/                  Next routes. Product routes live under the
 *                             product's slug; everything else is platform.
 */
const WEB = "^apps/web/src";

/**
 * Each product's route folder, and the code folder it alone may import.
 *
 * ⚠️ THE TWO NAMES CAN DIFFER, AND THAT IS WHY THIS IS A MAP RATHER THAN A
 * REGEX CAPTURE. The route segment comes from `MODULE_CATALOGUE.slug` — what a
 * customer sees in the address bar — and the code folder is named after the
 * domain. `invoice-chasing` is served by `invoice-follow-up`. A `$1`
 * backreference of the kind the API's config uses would silently match nothing
 * there, which is the worst possible outcome for a wall: it passes because it
 * cannot see.
 *
 * ⚠️ THE LEAD PRODUCT'S TWO NAMES NOW MATCH, AND THIS MAP IS WHY THAT WAS NOT
 * FREE. Its code folder was `lead-follow-up` until slice 3.1c-1 renamed it to
 * `lead-follow-up-email`, to agree with the API folder that arrived with the
 * product's first owned table — and `product-owner.spec.ts` is what demanded
 * the agreement. **This line is a SECOND place the folder name lives**, so the
 * rename made it stale and the rule immediately forbade the lead screens from
 * importing their own code. Caught by `pnpm boundaries`, which is the wall
 * working; worth knowing that renaming a product folder is two edits, not one.
 *
 * ⚠️ ADDING A PRODUCT IS ONE LINE HERE. That was the promise made in
 * `ARCHITECTURE-PLATFORM-AND-PRODUCTS.md` §4, and slice 3.1a is the first time
 * anything has tested it. It held: one line, and both walls covered the new
 * product.
 */
const PRODUCT_FOLDERS = {
  "invoice-chasing": "invoice-follow-up",
  "lead-follow-up-email": "lead-follow-up-email",
};

const PRODUCT_ROUTES = Object.keys(PRODUCT_FOLDERS).map((slug) => `${WEB}/app/app/${slug}/`);

/**
 * ⚠️ KNOWN CROSSINGS, RECORDED RATHER THAN PRETENDED AWAY (2026-08-19).
 *
 * Two PLATFORM routes render invoice-follow-up content:
 *
 *  - `app/app/clients/[customerId]/invoices/` — a client's invoices. Clients
 *    are platform (one client record, BRD §3.1.3) but their invoices are the
 *    product's.
 *  - `app/app/settings/reminders/` — reminder timing. Platform settings
 *    holding one product's configuration.
 *
 * **Deliberately not fixed here.** The honest fix moves those screens under
 * the product's slug, and that CHANGES CUSTOMER-FACING URLS — a founder
 * decision, not a refactor to smuggle into an audit fix. Recorded so it stays
 * visible, and the rule below fails if a THIRD platform route joins them.
 *
 * ⚠️ NOTHING MAY BE ADDED HERE WITHOUT A REASON WRITTEN NEXT TO IT. An
 * exception list that grows silently is how a boundary dies politely.
 */
const DECLARED_CROSSINGS = [
  `${WEB}/app/app/clients/\\[customerId\\]/invoices/`,
  `${WEB}/app/app/settings/reminders/`,
];

module.exports = {
  forbidden: [
    {
      name: "web-shared-imports-product",
      comment:
        "src/lib/ is the shared kernel and must have NO product meaning. This is the rule that " +
        "would have caught eight invoice modules sitting in lib/ next to money.ts — the web app's " +
        "version of ledger.ts in common/.",
      severity: "error",
      from: { path: `${WEB}/lib/` },
      to: { path: `${WEB}/(products|capabilities)/` },
    },
    {
      name: "web-capability-imports-product",
      comment:
        "Shared machinery must not depend on a product. The mailbox screens serve invoice " +
        "follow-up AND lead follow-up by email; the moment they import one, they stop being shared.",
      severity: "error",
      from: { path: `${WEB}/capabilities/` },
      to: { path: `${WEB}/products/` },
    },
    {
      name: "web-cross-product-import",
      comment:
        "No product may import another product. This is the rule that stops a change to lead " +
        "follow-up breaking invoice chasing's screens.",
      severity: "error",
      from: { path: `${WEB}/products/([^/]+)/` },
      to: {
        path: `${WEB}/products/([^/]+)/`,
        pathNot: `${WEB}/products/$1/`,
      },
    },
    {
      name: "web-cross-capability-import",
      comment:
        "Capabilities are independent machinery. One reaching into another turns two small, " +
        "replaceable things into one unreplaceable one.",
      severity: "error",
      from: { path: `${WEB}/capabilities/([^/]+)/` },
      to: {
        path: `${WEB}/capabilities/([^/]+)/`,
        pathNot: `${WEB}/capabilities/$1/`,
      },
    },
    {
      name: "platform-route-imports-product",
      comment:
        "A platform screen must not import a product's code. A customer holding only lead " +
        "follow-up still reaches Clients and Settings, so anything those screens import is " +
        "something every customer carries. The two existing crossings are declared above with " +
        "reasons; a third one fails here.",
      severity: "error",
      from: {
        path: `${WEB}/app/`,
        pathNot: [...PRODUCT_ROUTES, ...DECLARED_CROSSINGS],
      },
      to: { path: `${WEB}/products/` },
    },
    /**
     * ⚠️ NO LONGER DORMANT — 2026-08-20. The previous version of this rule said
     * "today there is one product route folder, so this rule is dormant — it
     * becomes the load-bearing one the day lead follow-up gets its own
     * screens." That day is today, and it arrived with the rule still hardcoded
     * to `invoice-follow-up`: every lead screen would have been free to import
     * invoice code and the wall would have said nothing.
     *
     * One rule per product now, because each route folder has a different
     * permitted code folder. Both were proved by injecting a violation, not by
     * reading the config.
     */
    ...Object.entries(PRODUCT_FOLDERS).map(([slug, folder]) => ({
      name: `product-route-imports-other-product`,
      comment:
        `A product's own screens may use that product's code and nothing from a sibling. ` +
        `Screens under /app/${slug}/ may import products/${folder}/ and no other product.`,
      severity: "error",
      from: { path: `${WEB}/app/app/${slug}/` },
      to: {
        path: `${WEB}/products/([^/]+)/`,
        pathNot: `${WEB}/products/${folder}/`,
      },
    })),
    {
      name: "no-unresolvable",
      comment:
        "⚠️ THIS RULE IS WHAT STOPS THE WALL LYING. dependency-cruiser silently ignores an import " +
        "it cannot resolve, so a rule can only be broken by a path that RESOLVES. When the eight " +
        "product modules moved out of lib/ on 2026-08-19, the web tests still pointed at " +
        "`../src/lib/…`; the cruise reported a clean 146 modules while those imports were broken, " +
        "and only `tsc` caught it. A boundary that passes because it cannot see is worse than none.",
      severity: "error",
      from: {},
      to: {
        couldNotResolve: true,
        /**
         * INTERNAL paths only: relative (`../src/…`) and alias (`@/…`), the two
         * forms this app uses to import its own code. Bare package specifiers
         * are out of scope — see the twin config for why `express` would
         * otherwise fail for no defect. Missing real packages are caught by
         * `typecheck` and the build.
         */
        path: "^(\\.|@/)",
      },
    },
    {
      name: "no-circular",
      comment:
        "A cycle means neither file can be understood, tested or moved on its own — and it is how " +
        "a boundary quietly stops being one.",
      severity: "error",
      from: {},
      to: { circular: true },
    },
    {
      name: "no-orphans",
      comment: "Dead file: nothing imports it. Delete it rather than leaving it to be maintained.",
      severity: "warn",
      from: {
        orphan: true,
        pathNot: [
          "\\.d\\.ts$",
          /**
           * Next.js entrypoints are called by the framework, never imported, so
           * "nothing imports it" is their normal state and not a finding.
           */
          "(^|/)(page|layout|template|loading|error|global-error|not-found|route|default|middleware|instrumentation|instrumentation-client|sitemap|robots|opengraph-image)\\.(ts|tsx)$",
          "(^|/)\\.[^/]+\\.(js|cjs|mjs|ts|tsx|json)$",
          "\\.spec\\.tsx?$",
        ],
      },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: { path: "(^|/)(node_modules|dist|\\.next|generated)/" },
    /**
     * Type-only imports count. `import type { X } from "@/products/…"` inside a
     * platform screen is still the platform knowing a product's shape, and it
     * is the form the violation would most plausibly arrive in.
     */
    tsPreCompilationDeps: true,
    /**
     * Without this, every `@/…` import is unresolvable and no rule can match.
     * ⚠️ NOT `apps/web/tsconfig.json` — see the note inside the file below.
     */
    tsConfig: { fileName: ".dependency-cruiser.web.tsconfig.json" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"],
    },
  },
};
