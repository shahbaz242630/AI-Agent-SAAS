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
