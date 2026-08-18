import { describe, expect, it } from "vitest";
import { SESSION_IDLE_TIMEOUT_CODE, SESSION_IDLE_TIMEOUT_MS, isSessionIdle } from "@eva/types";
import { IDLE_SIGN_OUT_PATH, sessionFailureDestination } from "@/lib/session";
import { readActivityStamp, routeKind } from "@/lib/supabase/proxy";

/**
 * The two-day idle sign-out (founder's request, 2026-08-12).
 *
 * ⚠️ EVERY FAILURE MODE HERE LOCKS SOMEBODY OUT OF A WORKING ACCOUNT, and none
 * of them looks wrong while you are developing: you signed in a minute ago, so
 * you are never the idle case. These are the pure rules, pulled out where a
 * test can reach them — the proxy and the API both act on this one function so
 * the browser and the server cannot come to different conclusions.
 */
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

describe("when a session counts as idle", () => {
  const now = new Date("2026-08-12T12:00:00.000Z");

  /**
   * ⚠️ THE ONE THAT WOULD END EVERY LIVE SESSION ON DEPLOY. `last_seen_at` is
   * null on every existing row the moment the column ships, and "unknown" read
   * as "idle since the epoch" signs out the entire customer base at once — from
   * a change whose whole purpose was to be invisible to active users.
   */
  it("treats an unknown last-seen as FRESH, never as ancient", () => {
    expect(isSessionIdle(null, now)).toBe(false);
    expect(isSessionIdle(undefined, now)).toBe(false);
  });

  it("leaves a session alone right up to the limit", () => {
    expect(isSessionIdle(new Date(now.getTime() - 2 * DAY + MINUTE), now)).toBe(false);
    expect(isSessionIdle(new Date(now.getTime() - MINUTE), now)).toBe(false);
    expect(isSessionIdle(now, now)).toBe(false);
  });

  it("ends it once the limit is past", () => {
    expect(isSessionIdle(new Date(now.getTime() - 2 * DAY - MINUTE), now)).toBe(true);
    expect(isSessionIdle(new Date(now.getTime() - 30 * DAY), now)).toBe(true);
  });

  /** The founder asked for two days. Pinned so a later edit has to mean it. */
  it("is two days, not two hours and not two weeks", () => {
    expect(SESSION_IDLE_TIMEOUT_MS).toBe(2 * DAY);
  });

  /**
   * A clock skew or a browser writing a future stamp must not read as idle —
   * the arithmetic goes negative, and a naive `Math.abs` would sign them out.
   */
  it("does not call a future stamp idle", () => {
    expect(isSessionIdle(new Date(now.getTime() + 10 * DAY), now)).toBe(false);
  });
});

describe("the stamp the browser carries", () => {
  /**
   * ⚠️ ANYTHING UNREADABLE MUST BECOME null, WHICH MEANS FRESH. A cookie can be
   * absent, empty, truncated or edited by hand, and every one of those has to
   * land on "I don't know, so let them in and stamp it" — the alternative is an
   * account that cannot be used until the customer clears their cookies.
   */
  it("reads nothing out of nonsense", () => {
    expect(readActivityStamp(undefined)).toBeNull();
    expect(readActivityStamp("")).toBeNull();
    expect(readActivityStamp("yesterday")).toBeNull();
    expect(readActivityStamp("-1")).toBeNull();
    expect(readActivityStamp("0")).toBeNull();
    expect(readActivityStamp("NaN")).toBeNull();
  });

  it("reads a real stamp back as the moment it was written", () => {
    const written = new Date("2026-08-10T09:30:00.000Z");
    expect(readActivityStamp(String(written.getTime()))?.toISOString()).toBe(written.toISOString());
  });

  /** The round trip the proxy actually performs, end to end. */
  it("a stamp written now is not idle when read back", () => {
    const now = new Date("2026-08-12T12:00:00.000Z");
    expect(isSessionIdle(readActivityStamp(String(now.getTime())), now)).toBe(false);
  });
});

/**
 * Where a refused session is sent — the half that stops an inescapable loop.
 *
 * ⚠️ THE CASE THIS COVERS IS RARE AND UNESCAPABLE, WHICH IS THE WORST PAIR.
 * The server's stamp can go stale while the browser's stays fresh — it takes
 * the API being unreachable for two days with a tab left open. The customer
 * cannot get out of the loop it used to cause by doing anything to the product;
 * only by clearing cookies by hand, which nobody would think to do.
 */
describe("where a refused session is sent", () => {
  it("sends an idle session somewhere that can actually END it", () => {
    expect(sessionFailureDestination(SESSION_IDLE_TIMEOUT_CODE)).toBe(IDLE_SIGN_OUT_PATH);
  });

  /**
   * An expired or revoked token is the common case and `/sign-in` is right for
   * it: Supabase has already stopped vouching, so the page renders instead of
   * bouncing. Widening the idle branch to every 401 would drag that case
   * through a sign-out it does not need.
   */
  it("still sends an ordinary expired token to the sign-in page", () => {
    expect(sessionFailureDestination(undefined)).toBe("/sign-in");
    expect(sessionFailureDestination("module_not_entitled")).toBe("/sign-in");
    expect(sessionFailureDestination("")).toBe("/sign-in");
  });

  /**
   * ⚠️ THE SIGN-OUT ROUTE MUST BE OPEN, AND THIS IS NOT A DETAIL. Everything
   * reaching it is by definition still holding a valid Supabase cookie — that
   * is the whole reason it exists. List it as anonymous-only and the proxy
   * redirects the visitor to `/app` BEFORE the handler can clear anything, and
   * the loop is back with an extra hop in it.
   */
  it("leaves the sign-out route reachable by a signed-in visitor", () => {
    expect(routeKind("/auth/sign-out")).toBe("open");
  });

  /** It lands on the page whose copy explains the two-day rule. */
  it("asks for the wording that says what happened", () => {
    expect(IDLE_SIGN_OUT_PATH).toContain("reason=idle");
  });
});
