import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { configuredOrigin, publicOrigin, publicUrl } from "@/lib/public-origin";

/**
 * ⚠️ THE BUG THIS FILE EXISTS FOR WAS FOUND BY THE FOUNDER CLICKING A REAL
 * RESET EMAIL ON PRODUCTION (2026-08-11). The link came back to
 * `/auth/confirm`, the token was spent correctly, and the redirect that should
 * have finished the job pointed at `https://localhost:8080/new-password` —
 * Railway's container address, dressed as https by `x-forwarded-proto`. The
 * second dead-link defect in two days, and the second one where the code that
 * produced it looked entirely reasonable.
 */

const WEB_SRC = fileURLToPath(new URL("../src", import.meta.url));

describe("the origin Eva builds emailed links from", () => {
  it("is whatever configuration says, normalised to a bare origin", () => {
    expect(configuredOrigin({ WEB_PUBLIC_ORIGIN: "https://eva.example.com/" })).toBe(
      "https://eva.example.com",
    );
    expect(configuredOrigin({ WEB_PUBLIC_ORIGIN: "  http://localhost:3006  " })).toBe(
      "http://localhost:3006",
    );
  });

  /**
   * A configured origin carrying a path would silently prefix every emailed
   * link — `…/eva/auth/confirm` — and the links would half-work for a week.
   * Rejecting is louder and cheaper.
   */
  it("rejects anything that is not a bare origin", () => {
    expect(configuredOrigin({ WEB_PUBLIC_ORIGIN: "https://eva.example.com/app" })).toBeNull();
    expect(configuredOrigin({ WEB_PUBLIC_ORIGIN: "https://eva.example.com?x=1" })).toBeNull();
    expect(configuredOrigin({ WEB_PUBLIC_ORIGIN: "eva.example.com" })).toBeNull();
    expect(configuredOrigin({ WEB_PUBLIC_ORIGIN: "javascript:alert(1)" })).toBeNull();
    expect(configuredOrigin({ WEB_PUBLIC_ORIGIN: "" })).toBeNull();
    expect(configuredOrigin({})).toBeNull();
  });

  /**
   * ⚠️ IT THROWS RATHER THAN GUESSING, and that is the whole lesson of the two
   * defects. #79 guessed (Supabase's Site URL) and sent people to the marketing
   * page; 1.10f guessed (the request's own host) and sent them to localhost.
   * Both times the guess rendered a real page and looked like success.
   */
  it("refuses to invent one when it is missing", () => {
    expect(() => publicOrigin({})).toThrowError(/WEB_PUBLIC_ORIGIN is not set/);
    expect(() => publicUrl("/auth/confirm", {})).toThrowError(/WEB_PUBLIC_ORIGIN is not set/);
  });

  it("builds an absolute URL on our own origin", () => {
    expect(publicUrl("/new-password", { WEB_PUBLIC_ORIGIN: "https://eva.example.com" })).toBe(
      "https://eva.example.com/new-password",
    );
  });
});

/**
 * ⚠️ THE GUARD, IN THE SHAPE THE PREVIOUS ONE TAUGHT US TO USE (see
 * `auth-redirects.spec.ts`): read the source, and forbid the pattern rather
 * than assert a value. Both bad origins were plausible-looking expressions, not
 * wrong constants, so nothing about the OUTPUT of a passing run would have
 * caught either.
 */
describe("no server-side redirect may take our address from the request", () => {
  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) return sourceFiles(full);
      return /\.tsx?$/.test(entry) ? [full] : [];
    });
  }

  const sources = sourceFiles(WEB_SRC).map((file) => ({
    file: file.slice(WEB_SRC.length + 1).replace(/\\/g, "/"),
    // Comments name the defect on purpose, so they are not evidence of it.
    text: readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|[^:])\/\/.*$/gm, "$1"),
  }));

  /**
   * `nextUrl.origin` is the exact expression that shipped. Middleware may still
   * `nextUrl.clone()` — Next answers those with a RELATIVE `Location`, verified
   * against production on 2026-08-11 (`location: /sign-in`), so no host is
   * involved and nothing can be poisoned.
   *
   * ⚠️ THAT EXEMPTION WAS TRUE OF MIDDLEWARE AND FALSE OF ROUTE HANDLERS, and
   * the gap cost a second localhost defect on 2026-08-25 — see the test below.
   */
  it("never reads nextUrl.origin", () => {
    const offenders = sources.filter((source) => source.text.includes("nextUrl.origin"));

    expect(offenders.map((o) => o.file)).toEqual([]);
  });

  /**
   * ⚠️ AND NEVER THE FORWARDED HOST — the fix that looks obvious and is a
   * password-reset-poisoning hole. A forged `x-forwarded-host` makes OUR email
   * carry a link to SOMEBODY ELSE'S domain, and the customer is primed to click
   * it. OWASP WSTG-INPV-17; PortSwigger "HTTP Host header attacks". The domain
   * comes from configuration or it does not come at all.
   */
  it("never reads the host off the request either", () => {
    const offenders = sources.filter((source) =>
      /x-forwarded-host|headers\(\)\.get\(["']host["']\)|headers\.get\(["']host["']\)/i.test(
        source.text,
      ),
    );

    expect(offenders.map((o) => o.file)).toEqual([]);
  });

  it("builds the confirmation redirect from the configured origin", () => {
    const route = sources.find((source) => source.file === "app/auth/confirm/route.ts");

    expect(route, "the route that spends every emailed token has moved").toBeDefined();
    expect(route?.text).toContain("publicOrigin");
  });

  /**
   * ⚠️ THE 2026-08-25 DEFECT, AND THE HOLE IN THE GUARD ABOVE. `/auth/sign-out`
   * cloned `nextUrl` exactly as middleware is allowed to, and sent every idled
   * customer to `https://localhost:8080/signed-out?reason=idle`. Both halves
   * measured on production that morning:
   *
   *     /auth/sign-out?reason=idle -> https://localhost:8080/signed-out?...
   *     /app  (middleware)         -> /sign-in
   *
   * Middleware resolves a cloned `nextUrl` to a relative `Location`; a route
   * handler resolves it against the container's own address and emits it
   * absolute. So the exemption is real, and it is an exemption for MIDDLEWARE
   * — never for a handler under `app/**\/route.ts`.
   *
   * The customer cost is the part worth remembering: an idle session is the one
   * moment a person is already being interrupted, and this dropped them on a
   * dead machine with no way back but editing the address bar.
   */
  it("never builds a route handler's redirect from the request", () => {
    const handlers = sources.filter((source) => /^app\/.*route\.tsx?$/.test(source.file));

    expect(handlers.length, "the auth route handlers have moved or vanished").toBeGreaterThan(0);

    const offenders = handlers.filter((source) => /nextUrl\s*\.\s*clone\s*\(/.test(source.text));

    expect(offenders.map((o) => o.file)).toEqual([]);
  });

  it("ends an idle session on our own origin", () => {
    const route = sources.find((source) => source.file === "app/auth/sign-out/route.ts");

    expect(route, "the route that ends an idle session has moved").toBeDefined();
    expect(route?.text).toContain("publicUrl");
  });
});
