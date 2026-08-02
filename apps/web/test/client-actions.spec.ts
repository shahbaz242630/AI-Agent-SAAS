import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The messages these actions put in front of a customer (slice 1.6b).
 *
 * Copy is tested here because copy is what this project keeps shipping broken
 * through a green gate: "lowering to 1 seats" and "If you arethe administrator"
 * both reached staging. Every message below has a singular and a plural branch,
 * or a zero branch that must not read as a failure.
 *
 * The API calls themselves are stubbed — what they do is proven by the api
 * suite. What is NOT proven anywhere else is which sentence comes back.
 */

const apiFetch = vi.fn();
const redirect = vi.fn((path: string) => {
  throw new Error(`REDIRECT:${path}`);
});

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/api")>("../src/lib/api");
  return { ...actual, apiFetch: (...args: unknown[]) => apiFetch(...args) };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: (path: string) => redirect(path) }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getSession: async () => ({ data: { session: { access_token: "token" } } }) },
  }),
}));

function jsonResponse(body: unknown) {
  return { json: async () => body };
}

function form(entries: [string, string][]) {
  const data = new FormData();
  for (const [key, value] of entries) data.append(key, value);
  return data;
}

beforeEach(() => {
  apiFetch.mockReset();
  redirect.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("assignClients", () => {
  it("refuses an empty selection without calling the API", async () => {
    const { assignClients } = await import("../src/app/app/clients/actions");

    const state = await assignClients({}, form([["organisationId", "org-1"]]));

    expect(state.error).toMatch(/at least one client/i);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("sends null for the default mailbox — an explicit un-file, not an omission", async () => {
    apiFetch.mockResolvedValue(jsonResponse({ moved: 2 }));
    const { assignClients } = await import("../src/app/app/clients/actions");

    await assignClients(
      {},
      form([
        ["organisationId", "org-1"],
        ["customerIds", "c1"],
        ["customerIds", "c2"],
        ["emailAccountId", ""],
      ]),
    );

    const [, , init] = apiFetch.mock.calls[0] as [string, string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      customerIds: ["c1", "c2"],
      emailAccountId: null,
    });
  });

  it("says 1 client, never 1 clients", async () => {
    apiFetch.mockResolvedValue(jsonResponse({ moved: 1 }));
    const { assignClients } = await import("../src/app/app/clients/actions");

    const state = await assignClients(
      {},
      form([
        ["organisationId", "org-1"],
        ["customerIds", "c1"],
        ["emailAccountId", "mailbox-1"],
      ]),
    );

    expect(state.success).toContain("1 client ");
    expect(state.success).not.toContain("1 clients");
  });

  /** Zero moved is a real answer — they were already filed there. "Moved 0
   *  clients" reads as a bug, so it gets its own sentence. */
  it("does not report a no-op as if nothing worked", async () => {
    apiFetch.mockResolvedValue(jsonResponse({ moved: 0 }));
    const { assignClients } = await import("../src/app/app/clients/actions");

    const state = await assignClients(
      {},
      form([
        ["organisationId", "org-1"],
        ["customerIds", "c1"],
        ["emailAccountId", "mailbox-1"],
      ]),
    );

    expect(state.error).toBeUndefined();
    expect(state.success).toMatch(/already filed/i);
  });

  it("distinguishes filing under a mailbox from moving back to the default", async () => {
    apiFetch.mockResolvedValue(jsonResponse({ moved: 3 }));
    const { assignClients } = await import("../src/app/app/clients/actions");

    const filed = await assignClients(
      {},
      form([
        ["organisationId", "org-1"],
        ["customerIds", "c1"],
        ["emailAccountId", "mailbox-1"],
      ]),
    );
    const unfiled = await assignClients(
      {},
      form([
        ["organisationId", "org-1"],
        ["customerIds", "c1"],
        ["emailAccountId", ""],
      ]),
    );

    expect(filed.success).toMatch(/filed under that mailbox/i);
    expect(unfiled.success).toMatch(/default mailbox/i);
  });
});

describe("addClient", () => {
  /**
   * The founder's model: inside a mailbox's book, a new client is filed there
   * without anyone ticking anything. Two calls, because POST /customers is a
   * CORE endpoint that must keep working for an organisation with no mailbox.
   */
  it("files a new client under the mailbox whose book is open", async () => {
    apiFetch
      .mockResolvedValueOnce(jsonResponse({ id: "new-client" }))
      .mockResolvedValueOnce(jsonResponse({ moved: 1 }));
    const { addClient } = await import("../src/app/app/clients/actions");

    const state = await addClient(
      {},
      form([
        ["organisationId", "org-1"],
        ["emailAccountId", "mailbox-1"],
        ["name", "Acme Ltd"],
      ]),
    );

    expect(apiFetch).toHaveBeenCalledTimes(2);
    const [, , allocate] = apiFetch.mock.calls[1] as [string, string, RequestInit];
    expect(JSON.parse(String(allocate.body))).toEqual({
      customerIds: ["new-client"],
      emailAccountId: "mailbox-1",
    });
    expect(state.success).toBeDefined();
  });

  it("does not try to file a client added from the all-clients view", async () => {
    apiFetch.mockResolvedValueOnce(jsonResponse({ id: "new-client" }));
    const { addClient } = await import("../src/app/app/clients/actions");

    await addClient(
      {},
      form([
        ["organisationId", "org-1"],
        ["emailAccountId", ""],
        ["name", "Acme Ltd"],
      ]),
    );

    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  /**
   * Half-success must not read as total failure. The client EXISTS and is
   * chased from the default (ruling 1) — telling someone it failed would have
   * them add it a second time.
   */
  it("says the client was added even when filing it failed", async () => {
    const { ApiError } = await import("../src/lib/api");
    apiFetch
      .mockResolvedValueOnce(jsonResponse({ id: "new-client" }))
      .mockRejectedValueOnce(new ApiError("Mailbox not found", 400));
    const { addClient } = await import("../src/app/app/clients/actions");

    const state = await addClient(
      {},
      form([
        ["organisationId", "org-1"],
        ["emailAccountId", "mailbox-1"],
        ["name", "Acme Ltd"],
      ]),
    );

    expect(state.error).toMatch(/added/i);
    expect(state.error).toMatch(/default mailbox/i);
    // The API's own reason survives to the user (defect F4). Asserted because
    // the first version of this test built the ApiError with its arguments
    // reversed and still passed — every other assertion here is on OUR copy.
    expect(state.error).toContain("Mailbox not found");
  });

  it("omits blank optional fields rather than sending empty strings", async () => {
    apiFetch.mockResolvedValueOnce(jsonResponse({ id: "new-client" }));
    const { addClient } = await import("../src/app/app/clients/actions");

    await addClient(
      {},
      form([
        ["organisationId", "org-1"],
        ["name", "Acme Ltd"],
        ["email", "  "],
        ["phone", ""],
      ]),
    );

    const [, , init] = apiFetch.mock.calls[0] as [string, string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ name: "Acme Ltd" });
  });
});

describe("disconnectMailbox", () => {
  /** RULING 3: never silent. The count is the reason this endpoint stopped
   *  being a 204. */
  it("states how many clients moved and where they went", async () => {
    apiFetch.mockResolvedValue(
      jsonResponse({ clientsMoved: 4, movedToEmailAddress: "default@example.com" }),
    );
    const { disconnectMailbox } = await import("../src/app/app/settings/actions");

    const state = await disconnectMailbox(
      {},
      form([
        ["organisationId", "org-1"],
        ["mailboxId", "mailbox-1"],
      ]),
    );

    expect(state.success).toContain("4 clients");
    expect(state.success).toContain("default@example.com");
  });

  it("says 1 client is, never 1 clients are", async () => {
    apiFetch.mockResolvedValue(
      jsonResponse({ clientsMoved: 1, movedToEmailAddress: "default@example.com" }),
    );
    const { disconnectMailbox } = await import("../src/app/app/settings/actions");

    const state = await disconnectMailbox(
      {},
      form([
        ["organisationId", "org-1"],
        ["mailboxId", "mailbox-1"],
      ]),
    );

    expect(state.success).toContain("1 client is");
    expect(state.success).not.toContain("1 clients");
  });

  /** Disconnecting the LAST mailbox leaves nowhere to fall back to. Naming a
   *  dead address would be worse than admitting it. */
  it("warns when there is no mailbox left to chase from", async () => {
    apiFetch.mockResolvedValue(jsonResponse({ clientsMoved: 2, movedToEmailAddress: null }));
    const { disconnectMailbox } = await import("../src/app/app/settings/actions");

    const state = await disconnectMailbox(
      {},
      form([
        ["organisationId", "org-1"],
        ["mailboxId", "mailbox-1"],
      ]),
    );

    expect(state.success).toMatch(/no longer being chased/i);
  });

  it("keeps the plain message when nothing was filed there", async () => {
    apiFetch.mockResolvedValue(
      jsonResponse({ clientsMoved: 0, movedToEmailAddress: "default@example.com" }),
    );
    const { disconnectMailbox } = await import("../src/app/app/settings/actions");

    const state = await disconnectMailbox(
      {},
      form([
        ["organisationId", "org-1"],
        ["mailboxId", "mailbox-1"],
      ]),
    );

    expect(state.success).toBe("Mailbox disconnected.");
  });
});
