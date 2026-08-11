import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiFetch, getApiBaseUrl } from "../src/lib/api";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.unstubAllGlobals();
});

describe("getApiBaseUrl", () => {
  it("fails with a clear error when NEXT_PUBLIC_API_URL is missing", () => {
    delete process.env.NEXT_PUBLIC_API_URL;

    expect(() => getApiBaseUrl()).toThrowError(/NEXT_PUBLIC_API_URL is not set/);
  });
});

describe("apiFetch", () => {
  it("attaches the caller's access token as a Bearer header", async () => {
    process.env.NEXT_PUBLIC_API_URL = "http://localhost:3001";
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await apiFetch("/users/me", "access-token");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:3001/users/me");
    expect(init.headers).toMatchObject({ Authorization: "Bearer access-token" });
  });

  it("maps a 401 response to an ApiError with status 401", async () => {
    process.env.NEXT_PUBLIC_API_URL = "http://localhost:3001";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 401 })));

    const error = await apiFetch("/users/me", "access-token").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(401);
    expect((error as ApiError).message).toMatch(/sign in again/);
  });

  it("maps other non-2xx responses to a friendly ApiError", async () => {
    process.env.NEXT_PUBLIC_API_URL = "http://localhost:3001";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 500 })));

    const error = await apiFetch("/users/me", "access-token").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(500);
    expect((error as ApiError).message).toMatch(/unexpected error \(500\)/);
  });

  it("maps a network failure to a friendly ApiError without a status", async () => {
    process.env.NEXT_PUBLIC_API_URL = "http://localhost:3001";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));

    const error = await apiFetch("/users/me", "access-token").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBeUndefined();
    expect((error as ApiError).message).toMatch(/couldn't reach the Eva API/);
  });
});

/**
 * Defect F4 (found on live staging 2026-07-30): apiFetch built its message from
 * the status code alone and threw the response body away, so a dead Microsoft
 * grant reached the user as "unexpected error (400). Please try again." —
 * advice that is actively wrong, sitting directly under a status card giving
 * the correct advice.
 *
 * The API's GlobalExceptionFilter is what makes surfacing 4xx safe: it passes
 * through the message for client errors ("safe by construction") and rewrites
 * everything >= 500 to a bare "Internal server error". So 4xx is intentional,
 * user-facing text; 5xx is not worth showing anyone.
 */
describe("apiFetch — surfacing the API's own error message (F4)", () => {
  const jsonResponse = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  const failWith = async (response: Response): Promise<ApiError> => {
    process.env.NEXT_PUBLIC_API_URL = "http://localhost:3001";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    const error = await apiFetch("/anything", "access-token").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    return error as ApiError;
  };

  it("uses the API's message for a 4xx instead of the generic sentence", async () => {
    const error = await failWith(
      jsonResponse(400, {
        statusCode: 400,
        message: "Microsoft authorisation expired — reconnect the mailbox",
      }),
    );

    expect(error.message).toBe("Microsoft authorisation expired — reconnect the mailbox");
    expect(error.message).not.toMatch(/Please try again/);
    expect(error.status).toBe(400);
  });

  it("exposes a machine-readable code so callers can branch (1.6a's 402)", async () => {
    const error = await failWith(
      jsonResponse(402, {
        statusCode: 402,
        message: "Your organisation does not have this product",
        code: "module_not_entitled",
      }),
    );

    expect(error.code).toBe("module_not_entitled");
    expect(error.status).toBe(402);
  });

  it("keeps the generic sentence for a 5xx even when the body carries a message", async () => {
    // The filter rewrites every 5xx to "Internal server error" — showing that
    // to a customer is worse than our own copy, and surfacing 5xx bodies is how
    // internals leak.
    const error = await failWith(
      jsonResponse(500, { statusCode: 500, message: "Internal server error" }),
    );

    expect(error.message).toMatch(/unexpected error \(500\)/);
    expect(error.message).not.toMatch(/Internal server error/);
  });

  it("falls back to the generic sentence when the body is not JSON", async () => {
    const error = await failWith(new Response("<html>502 Bad Gateway</html>", { status: 400 }));

    expect(error.message).toMatch(/unexpected error \(400\)/);
    expect(error.message).not.toMatch(/html/);
  });

  it("falls back to the generic sentence when the body is empty", async () => {
    const error = await failWith(new Response(null, { status: 403 }));

    expect(error.message).toMatch(/unexpected error \(403\)/);
  });

  it("falls back when the JSON body has no usable message", async () => {
    const error = await failWith(jsonResponse(400, { statusCode: 400 }));

    expect(error.message).toMatch(/unexpected error \(400\)/);
  });

  it("joins an array message (Nest's validation shape)", async () => {
    const error = await failWith(
      jsonResponse(400, { statusCode: 400, message: ["name is required", "name is too long"] }),
    );

    expect(error.message).toBe("name is required, name is too long");
  });

  it("caps a hostile or runaway message rather than rendering it whole", async () => {
    const error = await failWith(
      jsonResponse(400, { statusCode: 400, message: "x".repeat(5_000) }),
    );

    expect(error.message.length).toBeLessThanOrEqual(300);
  });

  it("still prefers our own copy for a 401 over whatever the body says", async () => {
    const error = await failWith(jsonResponse(401, { statusCode: 401, message: "Unauthorized" }));

    expect(error.message).toMatch(/sign in again/);
    expect(error.status).toBe(401);
  });
});

/**
 * ⚠️ THE SECOND HALF OF THE 2026-08-11 LESSON. `/organisations` answered 500 to
 * every request the founder made for two hours. The API logged nothing — and
 * neither did the web app, which knew exactly which call had failed and said
 * only "Something went wrong" on screen and nothing at all in Railway. Two
 * services watched the same failure in silence, and the cause was eventually
 * found by querying the database by hand.
 */
describe("apiFetch — leaving a trail when a call fails", () => {
  const failing = async (
    response: Response | Error,
    path = "/organisations",
  ): Promise<{ error: ApiError; logged: string[] }> => {
    process.env.NEXT_PUBLIC_API_URL = "http://localhost:3001";
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementation(() =>
          response instanceof Error ? Promise.reject(response) : Promise.resolve(response),
        ),
    );
    const logged: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      logged.push(String(line));
    });
    const error = (await apiFetch(path, "access-token").catch((e: unknown) => e)) as ApiError;
    spy.mockRestore();
    return { error, logged };
  };

  it("carries the API's reference so a screen can print it", async () => {
    const { error } = await failing(
      new Response(JSON.stringify({ statusCode: 500, message: "Internal server error" }), {
        status: 500,
        headers: { "Content-Type": "application/json", "x-correlation-id": "ref-abc-123" },
      }),
    );

    expect(error.correlationId).toBe("ref-abc-123");
  });

  it("logs which call failed, with its status and reference", async () => {
    const { logged } = await failing(
      new Response(null, { status: 500, headers: { "x-correlation-id": "ref-abc-123" } }),
    );

    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("/organisations");
    expect(logged[0]).toContain("500");
    expect(logged[0]).toContain("ref-abc-123");
  });

  it("says why the API was unreachable instead of swallowing the cause", async () => {
    const { error, logged } = await failing(new TypeError("getaddrinfo ENOTFOUND api.example"));

    // The customer keeps the friendly line…
    expect(error.message).toMatch(/couldn't reach the Eva API/);
    // …the log keeps the reason.
    expect(logged[0]).toContain("ENOTFOUND");
    expect(logged[0]).toContain("/organisations");
  });

  /** A log that fills with expired sessions and unheld modules is a log nobody
   *  reads — and both are answered properly on screen already. */
  it("stays quiet for the routine 4xx", async () => {
    const { logged } = await failing(new Response(null, { status: 401 }));
    expect(logged).toHaveLength(0);

    const { logged: entitlement } = await failing(new Response(null, { status: 402 }));
    expect(entitlement).toHaveLength(0);
  });

  it("never writes the caller's access token into the log", async () => {
    const { logged } = await failing(new Response(null, { status: 503 }));

    expect(logged.join(" ")).not.toContain("access-token");
  });
});
