/**
 * Architecture boundaries, enforced (BRD §3.1.2 and §8; AGENTS.md rules A1–A7).
 *
 * ⚠️ THIS FILE IS THE WALL. Everything else about the platform/product split is
 * a naming convention that survives exactly as long as somebody remembers it.
 * Founder ruling 2026-08-19: products are plug-and-play, so that one product
 * can be debugged, changed and switched off without touching another.
 *
 * The layers, outermost first:
 *
 *   products/      self-contained verticals. May use platform + capabilities.
 *   capabilities/  shared machinery (mailbox, extraction, voice). Not sold.
 *   platform/      the base: identity, orgs, permissions, entitlements,
 *                  clients, suppression, audit, health.
 *   common/        framework plumbing with NO business meaning.
 *
 * Dependencies point INWARD only. The reverse — the base knowing the names of
 * the things plugged into it — is what stops a new product being a folder.
 */
const SRC = "^apps/api/src";

module.exports = {
  forbidden: [
    {
      name: "platform-imports-product",
      comment:
        "The platform must never import a product. A base that knows its plug-ins is not a base — " +
        "adding the CRM would mean editing the foundation instead of adding a folder.",
      severity: "error",
      from: { path: `${SRC}/platform/` },
      to: { path: `${SRC}/(products|capabilities)/` },
    },
    {
      name: "capability-imports-product",
      comment:
        "Shared machinery must not depend on a product. Mailbox is used by invoice follow-up AND " +
        "lead follow-up; the moment it imports one of them it stops being shared.",
      severity: "error",
      from: { path: `${SRC}/capabilities/` },
      to: { path: `${SRC}/products/` },
    },
    {
      name: "cross-product-import",
      comment:
        "No product may import another product. This is the rule that stops fixing one product " +
        "breaking another. Where products must react to each other, publish a domain event.",
      severity: "error",
      from: { path: `${SRC}/products/([^/]+)/` },
      to: {
        path: `${SRC}/products/([^/]+)/`,
        pathNot: `${SRC}/products/$1/`,
      },
    },
    {
      name: "cross-capability-import",
      comment:
        "Capabilities are independent machinery. One reaching into another turns two small, " +
        "replaceable things into one unreplaceable one.",
      severity: "error",
      from: { path: `${SRC}/capabilities/([^/]+)/` },
      to: {
        path: `${SRC}/capabilities/([^/]+)/`,
        pathNot: `${SRC}/capabilities/$1/`,
      },
    },
    {
      name: "common-imports-business-code",
      comment:
        "common/ is framework plumbing with NO business meaning. It is the shared kernel, and a " +
        "shared kernel that grows business rules becomes the God library nothing can change safely. " +
        "This rule is why ledger.ts moved out to the invoice product on 2026-08-19.",
      severity: "error",
      from: { path: `${SRC}/common/` },
      to: { path: `${SRC}/(platform|capabilities|products)/` },
    },
    {
      name: "no-unresolvable",
      comment:
        "⚠️ THIS RULE IS WHAT STOPS THE WALL LYING. dependency-cruiser silently ignores an import " +
        "it cannot resolve, so every rule above can only be broken by a path that RESOLVES. A " +
        "folder move that leaves a stale path behind therefore reports CLEAN. That happened in the " +
        "web app on 2026-08-19 (see the twin config) and it is the same hazard the four hardcoded " +
        "`src/modules/…` strings were during the platform split.",
      severity: "error",
      from: {},
      to: {
        couldNotResolve: true,
        /**
         * INTERNAL paths only — anything starting with `.`. Bare package
         * specifiers are deliberately out of scope: `import type { Request }
         * from "express"` is type-only, erased at compile time and satisfied by
         * the declared `@types/express`, but the runtime package is a
         * transitive dep of `@nestjs/platform-express` and so does not resolve
         * here. Six of those would fail this rule for no defect. Missing real
         * packages are already caught by `typecheck` and by the build.
         */
        path: "^\\.",
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
          "(^|/)\\.[^/]+\\.(js|cjs|mjs|ts|json)$",
          "(^|/)(babel|webpack)\\.config\\.(js|cjs|mjs|ts|json)$",
          "(^|/)(main|instrument)\\.ts$",
          "\\.spec\\.ts$",
        ],
      },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: { path: "(^|/)(node_modules|dist|\\.next|generated)/" },
    /**
     * Type-only imports count. `import type { X } from "../../products/…"` is
     * still the platform knowing a product's shape, and it is the form the
     * violation would most plausibly arrive in.
     */
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      extensions: [".ts", ".js", ".mjs", ".cjs", ".json"],
    },
  },
};
