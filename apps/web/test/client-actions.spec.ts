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
  /**
   * The result goes back as a REDIRECT FLASH, not as action state.
   *
   * Returning it as state put ruling 3's one guarantee inside the mailbox
   * card's own controls — and disconnecting removes that card from the
   * re-rendered list, so the component holding the sentence unmounted as the
   * sentence arrived. The connect flow already used a URL flash for exactly
   * this reason; disconnect now does too.
   */
  it("redirects with both counts and the address, so the message outlives the card", async () => {
    apiFetch.mockResolvedValue(
      jsonResponse({
        clientsMoved: 4,
        unfiledClientsMoved: 120,
        movedToEmailAddress: "default@example.com",
      }),
    );
    const { disconnectMailbox } = await import("../src/capabilities/mailbox/actions");

    await expect(
      disconnectMailbox(
        {},
        form([
          ["organisationId", "org-1"],
          ["mailboxId", "mailbox-1"],
          // Which product's mailbox screen the flash has to land on. Since
          // slice 3.1c-0 there is no organisation-wide one to fall back to.
          ["moduleKey", "email_credit_controller"],
        ]),
      ),
    ).rejects.toThrow(/^REDIRECT:/);

    const target = String(redirect.mock.calls.at(-1)?.[0]);
    expect(target).toContain("/app/invoice-chasing/mailbox?");
    const params = new URLSearchParams(target.split("?")[1]);
    expect(params.get("moved")).toBe("4");
    // The group that was nearly lost: unfiled clients follow the default.
    expect(params.get("unfiled")).toBe("120");
    expect(params.get("to")).toBe("default@example.com");
  });
});

/**
 * The sentence itself, tested directly. Every branch is a number-agreement
 * trap, and this project has shipped "lowering to 1 seats" and "If you arethe
 * administrator" through a fully green gate.
 */
describe("disconnectMessage", () => {
  it("names both groups, because they are different people", async () => {
    const { disconnectMessage } = await import("../src/capabilities/mailbox/mailbox-messages");

    const message = disconnectMessage(3, 120, "default@example.com");

    expect(message).toContain("3 clients filed there");
    expect(message).toContain("120 clients you hadn't filed");
    expect(message).toContain("default@example.com");
  });

  it("says is for exactly one client and are for more", async () => {
    const { disconnectMessage } = await import("../src/capabilities/mailbox/mailbox-messages");

    expect(disconnectMessage(1, 0, "d@example.com")).toContain("1 client filed there is now");
    expect(disconnectMessage(0, 1, "d@example.com")).toContain("1 client you hadn't filed is now");
    expect(disconnectMessage(2, 0, "d@example.com")).toContain("are now");
    // The trap in the obvious spelling: keying "is/are" off which branch built
    // the phrase gives "1 client you hadn't filed are now chased".
    expect(disconnectMessage(0, 1, "d@example.com")).not.toContain("are now");
  });

  it("omits a group that did not move rather than saying zero", async () => {
    const { disconnectMessage } = await import("../src/capabilities/mailbox/mailbox-messages");

    const message = disconnectMessage(2, 0, "d@example.com");
    expect(message).not.toContain("0 ");
    expect(message).not.toContain("hadn't filed");
  });

  it("stays plain when nothing moved at all", async () => {
    const { disconnectMessage } = await import("../src/capabilities/mailbox/mailbox-messages");

    expect(disconnectMessage(0, 0, "d@example.com")).toBe("Mailbox disconnected.");
  });

  /** The last mailbox: there is nowhere to fall back to, and saying "chased
   *  from …" would name an address that no longer exists. */
  it("says chasing has STOPPED when that was the last mailbox", async () => {
    const { disconnectMessage } = await import("../src/capabilities/mailbox/mailbox-messages");

    const message = disconnectMessage(2, 5, null);
    expect(message).toMatch(/no longer being chased/i);
    expect(message).toContain("7 clients");
  });

  it("does not claim clients are stranded when there were none", async () => {
    const { disconnectMessage } = await import("../src/capabilities/mailbox/mailbox-messages");

    expect(disconnectMessage(0, 0, null)).toBe("Mailbox disconnected. Nothing is connected now.");
  });
});

/**
 * The sentence shown BEFORE a replace is committed.
 *
 * The defect these pin: the default-status clause hung off "does it have
 * clients", not "is it the default", so replacing a non-default mailbox that
 * held clients announced that its default status moved too. Staging,
 * 2026-08-03 — a true sentence with a false implication, which is exactly the
 * shape of copy defect this slice already had to fix once.
 */
describe("replaceMessage", () => {
  it("does NOT mention default status for a mailbox that is not the default", async () => {
    const { replaceMessage } = await import("../src/capabilities/mailbox/mailbox-messages");

    const message = replaceMessage("second@example.com", 2, false);

    expect(message).toContain("Its 2 clients move across.");
    expect(message).not.toMatch(/default/i);
  });

  it("mentions default status only when the mailbox actually holds it", async () => {
    const { replaceMessage } = await import("../src/capabilities/mailbox/mailbox-messages");

    const message = replaceMessage("primary@example.com", 2, true);

    expect(message).toContain("Its 2 clients move across.");
    expect(message).toMatch(/default for unfiled clients/i);
  });

  /** The two facts are independent: being the default says nothing about
   *  whether anything is filed under it, and vice versa. */
  it("states default status even when nothing is filed under it", async () => {
    const { replaceMessage } = await import("../src/capabilities/mailbox/mailbox-messages");

    const message = replaceMessage("primary@example.com", 0, true);

    expect(message).toContain("Anything filed under it moves across.");
    expect(message).toMatch(/default for unfiled clients/i);
  });

  it("says client moves for exactly one and clients move for more", async () => {
    const { replaceMessage } = await import("../src/capabilities/mailbox/mailbox-messages");

    expect(replaceMessage("a@example.com", 1, false)).toContain("Its client moves across.");
    expect(replaceMessage("a@example.com", 3, false)).toContain("Its 3 clients move across.");
    expect(replaceMessage("a@example.com", 1, false)).not.toContain("clients move");
  });

  it("keeps its spaces — the sentence is built, not assembled from JSX", async () => {
    const { replaceMessage } = await import("../src/capabilities/mailbox/mailbox-messages");

    expect(replaceMessage("a@example.com", 2, true)).toBe(
      "Swap a@example.com for a different address. Its 2 clients move across. It is the default for unfiled clients, and that moves across too.",
    );
  });
});
