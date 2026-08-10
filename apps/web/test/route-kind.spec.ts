import { describe, expect, it } from "vitest";
import { routeKind } from "@/lib/supabase/proxy";

/**
 * Who is allowed where (slice 1.10e).
 *
 * ⚠️ THIS IS THE PART OF THE AUTH WORK THAT FAILS SILENTLY FOR SOMEBODY ELSE.
 * Every one of these routes renders perfectly while you are developing it,
 * because you are signed out and looking at the signed-out case. Put
 * `/new-password` in the anonymous-only list by mistake and nothing looks
 * wrong — the recovery link simply bounces to the dashboard for a real
 * customer, who never gets to set a password and has no idea why.
 */
describe("route kinds", () => {
  it("keeps the app behind a session", () => {
    expect(routeKind("/app")).toBe("protected");
    expect(routeKind("/app/invoices")).toBe("protected");
    expect(routeKind("/app/onboarding")).toBe("protected");
  });

  it("keeps the sign-in pages for anonymous visitors only", () => {
    for (const path of ["/sign-in", "/sign-up", "/signed-out", "/reset-password"]) {
      expect(routeKind(path), path).toBe("anonymous-only");
    }
  });

  /**
   * ⚠️ BOTH PASSWORD SCREENS NEED A SESSION, AND ONE OF THEM IS EASY TO GET
   * WRONG. `/new-password` is reached with a session Supabase minted from a
   * recovery link — the holder IS signed in by then. Leaving it open would put
   * a "choose a new password" form in front of anybody at all.
   */
  it("keeps both password screens behind a session", () => {
    expect(routeKind("/change-password")).toBe("protected");
    expect(routeKind("/new-password")).toBe("protected");
  });

  /**
   * ⚠️ `/new-password` IS NOT NESTED UNDER `/reset-password` FOR EXACTLY THIS
   * REASON. As `/reset-password/new` it would inherit anonymous-only and bounce
   * the one session it exists to serve. The test states the trap so the next
   * person tidying the URLs meets it before their customers do.
   */
  it("does not let the reset prefix swallow the new-password screen", () => {
    expect(routeKind("/reset-password/new")).toBe("anonymous-only");
    expect(routeKind("/new-password")).not.toBe("anonymous-only");
  });

  /**
   * ⚠️ THE EMAIL LANDING POINT MUST BE OPEN TO BOTH. A recovery link is opened
   * by somebody signed out on a new device, or signed in on the one they asked
   * from. A redirect either way eats the token before the route can spend it.
   */
  it("leaves the email confirm route open to everyone", () => {
    expect(routeKind("/auth/confirm")).toBe("open");
  });

  it("leaves the public pages open", () => {
    expect(routeKind("/")).toBe("open");
    expect(routeKind("/microsoft-approved")).toBe("open");
  });

  /** Prefixes must end at a segment boundary, or a neighbour inherits them. */
  it("matches on segment boundaries, not on string prefixes", () => {
    expect(routeKind("/sign-in-help")).toBe("open");
    expect(routeKind("/applications")).toBe("open");
    expect(routeKind("/new-password-reset")).toBe("open");
  });
});
