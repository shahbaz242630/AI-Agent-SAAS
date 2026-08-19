import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * ⚠️ FOUND BY BROWSING THE LOCAL APP, 2026-08-11. The founder opened the
 * invoices screen while their record was in the state that broke production
 * that morning. The API answered 409 — correctly, with a sentence written for a
 * human to read — and the screen turned it into a raw Next.js crash page. The
 * message never appeared anywhere.
 *
 * Eleven of the twelve signed-in screens fetched `/organisations` with no
 * guard at all. Only Home had one. That meant every failure of the FIRST call
 * every screen makes — an expired session, a 409, a 503 while the database is
 * unreachable — was a crash rather than an explanation.
 *
 * ⚠️ AND THE 401 CASE GOT MORE LIKELY THE SAME DAY. Password changes now revoke
 * other sessions on purpose, so a customer who changes their password on their
 * phone and returns to an open laptop tab is precisely the person who would
 * have met a stack trace.
 */

const WEB_SRC = fileURLToPath(new URL("../src", import.meta.url));
const APP_SCREENS = join(WEB_SRC, "app", "app");

function pageFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return pageFiles(full);
    return entry === "page.tsx" ? [full] : [];
  });
}

const screens = pageFiles(APP_SCREENS).map((file) => ({
  route: `/app${file
    .slice(APP_SCREENS.length)
    .replace(/\\/g, "/")
    .replace(/\/page\.tsx$/, "")}`,
  text: readFileSync(file, "utf8"),
}));

describe("every signed-in screen resolves its organisation the same way", () => {
  it("finds the screens (a guard over an empty list proves nothing)", () => {
    expect(screens.length).toBeGreaterThan(8);
  });

  /**
   * ⚠️ ONE HELPER, NOT ELEVEN TRY/CATCHES. Eleven copies of the same three
   * lines is how the dashboard ended up being the only one that handled a 401:
   * somebody wrote it once, correctly, and it never propagated.
   *
   * ⚠️ HOME IS THE ONE EXEMPTION, AND IT IS EARNED RATHER THAN HISTORICAL. It
   * catches the failure itself and renders the API's OWN message beside the
   * correlation id — so a 503 reads "Eva can't reach its database just now"
   * rather than the boundary's generic "this screen couldn't load". That is
   * strictly more useful, on the screen a customer lands on first. If Home ever
   * stops handling it, this test starts failing for the right reason.
   */
  /**
   * ⚠️ MOVED FROM `/app` TO THE PRODUCT'S OWN ROUTE (2026-08-19). `/app` is the
   * hub now — a platform screen — and the richer 401/correlation-id handling
   * this exemption is about belongs to invoice chasing's Home, which moved with
   * it. Pointing this at `/app` after the move would have exempted the hub and
   * silently stopped checking the screen the rule was written for.
   */
  const EXEMPT = "/app/invoice-chasing";

  it("never calls apiFetch('/organisations') directly, except on Home", () => {
    const offenders = screens
      .filter((screen) => screen.route !== EXEMPT)
      .filter((screen) => /apiFetch\("\/organisations"/.test(screen.text));

    expect(offenders.map((screen) => screen.route)).toEqual([]);
  });

  it("keeps Home's richer handling — it must catch, not crash", () => {
    const home = screens.find((screen) => screen.route === EXEMPT);

    expect(home).toBeDefined();
    expect(home?.text).toMatch(/catch \(error\)/);
    expect(home?.text, "Home must still redirect an expired session").toMatch(/status === 401/);
    expect(home?.text, "Home must still show the reference").toMatch(/correlationId/);
  });

  it("goes through the guarded helper instead", () => {
    const users = screens.filter((screen) => /fetchOrganisations</.test(screen.text));

    // Home resolves its own and renders the failure inline with the reference,
    // so it is allowed to differ; everything else must use the helper.
    expect(users.length).toBeGreaterThanOrEqual(10);
  });
});

describe("fetchOrganisations", () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.doUnmock("next/navigation");
  });

  /** Loads the helper with `redirect` replaced by something a test can observe:
   *  the real one throws a framework-private signal. */
  async function load(): Promise<{
    fetchOrganisations: (token: string) => Promise<unknown>;
    redirects: string[];
  }> {
    const redirects: string[] = [];
    vi.doMock("next/navigation", () => ({
      redirect: (destination: string) => {
        redirects.push(destination);
        throw new Error("NEXT_REDIRECT");
      },
    }));
    // Not `module`: Next's lint bans assigning that identifier.
    const helper = await import("@/lib/organisations");
    return { fetchOrganisations: helper.fetchOrganisations, redirects };
  }

  it("returns the organisations on success", async () => {
    process.env.NEXT_PUBLIC_API_URL = "http://localhost:3001";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify([{ id: "org-1" }]), { status: 200 })),
    );
    const { fetchOrganisations } = await load();

    expect(await fetchOrganisations("token")).toEqual([{ id: "org-1" }]);
  });

  /** A dead session is not an error to report — it is a door to point at. */
  it("sends an expired session to sign-in rather than throwing", async () => {
    process.env.NEXT_PUBLIC_API_URL = "http://localhost:3001";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 401 })));
    const { fetchOrganisations, redirects } = await load();

    await expect(fetchOrganisations("token")).rejects.toThrow("NEXT_REDIRECT");
    expect(redirects).toEqual(["/sign-in"]);
  });

  /**
   * ⚠️ EVERYTHING ELSE IS RETHROWN ON PURPOSE, for `app/app/error.tsx` to
   * catch. Swallowing a 409 or a 503 here would put every screen back to
   * rendering something misleading — "create an organisation first" for a
   * database that is simply unreachable.
   */
  it.each([409, 500, 503])("rethrows a %s for the error boundary", async (status) => {
    process.env.NEXT_PUBLIC_API_URL = "http://localhost:3001";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status })));
    const { fetchOrganisations, redirects } = await load();

    await expect(fetchOrganisations("token")).rejects.toThrow();
    expect(redirects).toEqual([]);
  });
});

/**
 * ⚠️ THE BOUNDARY THAT CATCHES WHAT THE HELPER RETHROWS. Without this file a
 * rethrow is exactly the crash we started with.
 */
describe("the app error boundary", () => {
  const source = readFileSync(join(APP_SCREENS, "error.tsx"), "utf8");

  it("exists under the app shell, so the sidebar survives a broken screen", () => {
    expect(source).toContain('"use client"');
    expect(source).toMatch(/export default function/);
  });

  it("offers a retry and shows the reference that finds the log line", () => {
    expect(source).toMatch(/reset/);
    expect(source).toMatch(/digest/);
    expect(source).toMatch(/Reference/);
  });

  /** React strips server error messages in production, so showing
   *  `error.message` would print nothing useful and might print internals. */
  it("does not render the raw error message", () => {
    expect(source).not.toMatch(/\{error\.message\}/);
  });
});
