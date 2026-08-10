import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EMAIL_RETURN, emailReturnUrl } from "@/lib/auth-redirects";

/**
 * ⚠️ THE BUG THIS FILE EXISTS FOR SHIPPED TO PRODUCTION AND WAS FOUND BY A
 * HUMAN CLICKING A LINK (2026-08-10).
 *
 * `signUp` was called with no redirect at all, so Supabase fell back to the
 * project's Site URL — the marketing page — and handed it a `?code=` that page
 * cannot spend. Nothing errored. The account really was confirmed, the page
 * really did render, and the only symptom was a customer standing on a landing
 * page wondering whether it had worked.
 *
 * That is the failure mode worth guarding: not a crash, but a token quietly
 * thrown away by a redirect that points at a page which looks fine.
 */

const WEB_SRC = fileURLToPath(new URL("../src", import.meta.url));

describe("email return URLs", () => {
  it("always comes back through the route that spends the token", () => {
    expect(emailReturnUrl("https://eva.example", "/app")).toBe(
      "https://eva.example/auth/confirm?next=%2Fapp",
    );
  });

  /** Staging and production must each ask for their own origin. */
  it("uses the origin it is given rather than a baked-in one", () => {
    expect(emailReturnUrl("http://localhost:3006", "/new-password")).toBe(
      "http://localhost:3006/auth/confirm?next=%2Fnew-password",
    );
  });

  /**
   * `/auth/confirm` reads `next` straight off the query string, so a
   * destination carrying its own `?` or `&` would otherwise truncate there and
   * land somewhere nobody chose.
   */
  it("encodes the destination", () => {
    expect(emailReturnUrl("https://eva.example", "/app?tab=a&x=b")).toContain(
      "next=%2Fapp%3Ftab%3Da%26x%3Db",
    );
  });

  it("names a destination for each kind of email", () => {
    expect(EMAIL_RETURN.signUp).toBe("/app");
    expect(EMAIL_RETURN.passwordReset).toBe("/new-password");
  });
});

/**
 * ⚠️ THE GUARD THAT WOULD HAVE CAUGHT THE ORIGINAL DEFECT. Any call that makes
 * Supabase send an email must hand it a return URL — the shipped bug was an
 * ABSENT option, not a wrong one, so checking the value of something that isn't
 * there proves nothing. This reads the source and insists the option is present
 * and built by `emailReturnUrl`.
 */
describe("every email-sending call says where to come back to", () => {
  const EMAIL_SENDERS = [
    { call: "auth.signUp(", option: "emailRedirectTo" },
    { call: "auth.resetPasswordForEmail(", option: "redirectTo" },
  ];

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) return sourceFiles(full);
      return /\.tsx?$/.test(entry) ? [full] : [];
    });
  }

  const sources = sourceFiles(WEB_SRC).map((file) => ({
    file: file.slice(WEB_SRC.length + 1),
    // Comments describe the bug by name, so they are not evidence of the fix.
    text: readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|[^:])\/\/.*$/gm, "$1"),
  }));

  for (const { call, option } of EMAIL_SENDERS) {
    it(`passes ${option} wherever it calls ${call}`, () => {
      const callers = sources.filter((source) => source.text.includes(call));
      // If the call disappears entirely the guard is meaningless, so say so.
      expect(callers.length, `no caller of ${call} found`).toBeGreaterThan(0);

      for (const caller of callers) {
        expect(caller.text, `${caller.file} calls ${call} without ${option}`).toContain(option);
        expect(caller.text, `${caller.file} builds its own return URL`).toContain("emailReturnUrl");
      }
    });
  }
});
