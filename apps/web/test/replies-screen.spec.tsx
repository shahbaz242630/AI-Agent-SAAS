import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { moduleHref, type LeadReplyTemplateDto } from "@eva/types";
import { firstLine, sendsFromLine } from "@/products/lead-follow-up/replies-screen";

/**
 * The Replies screen, reshaped under ruling 89 (2026-09-05): a list per
 * channel that opens one editor at a time, and a line per channel saying where
 * its replies leave from.
 *
 * ⚠️ THE SERVER ACTIONS ARE STUBBED, NOT IMPORTED. `actions.ts` pulls in
 * `next/cache`, which does not exist in a node test; the list only needs the
 * actions to exist to render collapsed, so a stub is the honest dependency.
 */
vi.mock("@/app/app/lead-follow-up/replies/actions", () => ({
  addReplyTemplate: async () => ({}),
  deleteReplyTemplate: async () => ({}),
  saveReplyTemplate: async () => ({}),
  setAutomaticReply: async () => ({}),
  turnOffAutomaticReply: async () => ({}),
}));

const { ChannelWordings } = await import("@/app/app/lead-follow-up/replies/reply-controls");

function wording(overrides: Partial<LeadReplyTemplateDto> & { id: string }): LeadReplyTemplateDto {
  return {
    channel: "email",
    name: "Standard reply",
    body: "Thanks for getting in touch — your enquiry has come through and we have it.\n\nWe will read it properly.",
    isAutomatic: false,
    updatedAt: "2026-09-05T08:00:00.000Z",
    ...overrides,
  };
}

const templates = [
  wording({ id: "t-1", isAutomatic: true }),
  wording({
    id: "t-2",
    name: "Asking for more detail",
    body: "\n  To give you a proper answer, could you tell us:\n- Where the work is",
  }),
  wording({
    id: "t-3",
    name: "Out of hours",
    body: "Thanks — your enquiry has come through outside our working hours.",
  }),
];

const render = (props: Partial<Parameters<typeof ChannelWordings>[0]> = {}) =>
  renderToStaticMarkup(
    <ChannelWordings
      organisationId="org-1"
      channel="email"
      templates={templates}
      automaticTemplateId="t-1"
      canEdit
      connected
      {...props}
    />,
  );

describe("one channel's wordings, as a list (ruling 89)", () => {
  it("shows a row per wording — its name, its first line, the pill on the automatic one — with no editor open", () => {
    const html = render();
    expect(html.match(/aria-expanded="false"/g)).toHaveLength(3);
    expect(html).not.toContain("<form");
    expect(html).toContain("Standard reply");
    expect(html).toContain("your enquiry has come through and we have it.");
    // The first line that says anything, not a blank one.
    expect(html).toContain("To give you a proper answer, could you tell us:");
    expect(html.match(/Eva sends this one/g)).toHaveLength(1);
    expect(html).toContain("Add another reply");
  });

  it("says so when a channel holds no wording, and still offers to add one to an owner", () => {
    const empty = render({ templates: [] });
    expect(empty).toContain("No Email wordings yet.");
    expect(empty).toContain("Add another reply");
    expect(render({ templates: [], canEdit: false })).not.toContain("Add another reply");
  });

  /**
   * A node render cannot see grey. What it can hold the list to is that the
   * rows are still there and still openable when nothing is connected — the
   * panel's line does the explaining — and that the one mechanism for greying
   * is present. The effect itself is checked by eye on the walk.
   */
  it("keeps the rows when nothing is connected, greyed rather than gone", () => {
    const html = render({ connected: false });
    expect(html.match(/aria-expanded="false"/g)).toHaveLength(3);
    expect(html).toContain("opacity-60");
    expect(render()).not.toContain("opacity-60");
  });
});

describe("where a channel's replies leave from, in one line", () => {
  it("names the connected mailbox, and offers no link because there is nothing to fix", () => {
    expect(sendsFromLine("email", { from: "office@hallowayroofing.co.uk" })).toEqual({
      text: "Replies leave from office@hallowayroofing.co.uk.",
      action: null,
    });
  });

  it("says nothing is connected for email, and links to where a mailbox is connected", () => {
    expect(sendsFromLine("email", null)).toEqual({
      text: "Nothing connected yet, so these cannot go out.",
      action: { href: moduleHref("lead_follow_up", "mailbox"), label: "Connect a mailbox" },
    });
  });

  it("names the WhatsApp number, or admits it has no name, and never links — there is no screen to link to", () => {
    expect(sendsFromLine("whatsapp", { from: "+44 7700 900123" })).toEqual({
      text: "Replies leave from +44 7700 900123, under your business name.",
      action: null,
    });
    expect(sendsFromLine("whatsapp", { from: null }).text).toBe(
      "Replies leave from your WhatsApp number, under your business name.",
    );
  });

  it("says no WhatsApp number is connected, without a link", () => {
    expect(sendsFromLine("whatsapp", null)).toEqual({
      text: "No WhatsApp number is connected to Eva yet, so these cannot go out.",
      action: null,
    });
  });
});

describe("a wording's first line", () => {
  it("is the first line that says anything, trimmed", () => {
    expect(firstLine("\n   \n  Thanks for your message.  \nMore.")).toBe(
      "Thanks for your message.",
    );
  });

  it("is cut at a hundred characters with an ellipsis, so a long one cannot push the row to two", () => {
    const long = "a".repeat(140);
    expect(firstLine(long)).toHaveLength(100);
    expect(firstLine(long).endsWith("…")).toBe(true);
    expect(firstLine("a".repeat(100))).toBe("a".repeat(100));
  });

  it("is empty for an empty body", () => {
    expect(firstLine("")).toBe("");
    expect(firstLine("\n\n")).toBe("");
  });
});
