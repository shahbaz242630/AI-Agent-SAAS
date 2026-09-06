import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { moduleHref, type LeadPlaybookDto } from "@eva/types";
import {
  emptyBoxLine,
  instantReplyOff,
  OPENING_HOURS_HREF,
  sendsFromLine,
  silentChannels,
  switchBlockedLine,
} from "@/products/lead-follow-up/automations-screen";

/**
 * One card on the Automations screen, rendered (slice 3.5a, ruling 93).
 *
 * ⚠️ THE SERVER ACTIONS ARE STUBBED, NOT IMPORTED. `actions.ts` pulls in
 * `next/cache`, which does not exist in a node test; the card only needs the
 * actions to exist to render collapsed, so a stub is the honest dependency.
 */
vi.mock("@/app/app/lead-follow-up/automations/actions", () => ({
  clearPlaybookWording: async () => ({}),
  savePlaybookWording: async () => ({}),
  setPlaybookEnabled: async () => ({}),
}));

const { PlaybookCard } = await import("@/app/app/lead-follow-up/automations/playbook-controls");

const wording = (channel: "email" | "whatsapp", body: string) => ({
  id: `w-${channel}`,
  channel,
  body,
  updatedAt: "2026-09-06T08:00:00.000Z",
});

const INSTANT: LeadPlaybookDto = {
  key: "instant_reply",
  enabled: true,
  wordings: {
    email: wording("email", "Thanks for getting in touch — your enquiry has come through."),
    whatsapp: wording("whatsapp", "Thanks for your message — we've got it."),
  },
};

const AFTER_HOURS: LeadPlaybookDto = {
  key: "after_hours",
  enabled: false,
  wordings: {
    email: wording("email", "Your enquiry has come through outside our working hours."),
    whatsapp: null,
  },
};

const CONNECTED = {
  email: { from: "office@hallowayroofing.co.uk" },
  whatsapp: { from: "+44 7700 900123" },
};

const render = (props: Partial<Parameters<typeof PlaybookCard>[0]> = {}) =>
  renderToStaticMarkup(
    <PlaybookCard
      organisationId="org-1"
      playbook={INSTANT}
      sendsFrom={CONNECTED}
      openingHoursSet
      canEdit
      {...props}
    />,
  );

describe("a card, rendered", () => {
  it("shows the switch's state, a box per channel with its words, and one editor form per box", () => {
    const html = render();
    expect(html).toContain("Instant reply");
    expect(html).toContain("The moment an enquiry arrives, Eva sends this.");
    expect(html).toMatch(/>On</);
    expect(html).not.toMatch(/>Off</);
    // Two boxes, two editor forms; the switch and the clears are collapsed.
    expect(html.match(/<form/g)).toHaveLength(2);
    expect(html).toContain("your enquiry has come through.");
    expect(html).toContain("we&#x27;ve got it.");
    expect(html).toContain("Switch off");
    expect(html.match(/Clear this box/g)).toHaveLength(2);
  });

  it("says an empty box means silence on that channel, and offers nothing to clear", () => {
    const html = render({ playbook: AFTER_HOURS });
    expect(html).toContain(emptyBoxLine("whatsapp"));
    expect(html.match(/Clear this box/g)).toHaveLength(1);
    expect(html).toMatch(/>Off</);
  });

  it("offers no switch on the out-of-hours card until opening hours exist, and says where to set them", () => {
    const html = render({ playbook: AFTER_HOURS, openingHoursSet: false });
    expect(html).toContain("Eva needs your opening hours");
    expect(html).toContain(`href="${OPENING_HOURS_HREF}"`);
    expect(html).not.toContain("Switch on");
    // With hours, the switch is there.
    expect(render({ playbook: AFTER_HOURS })).toContain("Switch on");
  });

  it("renders no form and no switch for somebody who cannot edit, and still shows the words", () => {
    const html = render({ canEdit: false });
    expect(html).not.toContain("<form");
    expect(html).toContain("Only an owner can switch this on or off.");
    expect(html).toContain("your enquiry has come through.");
    expect(render({ canEdit: false, playbook: AFTER_HOURS })).toContain(emptyBoxLine("whatsapp"));
  });

  /**
   * A node render cannot see grey. What it can hold the box to is that the
   * words stay editable when nothing is connected — the line above says why —
   * and that the one mechanism for greying is present.
   */
  it("keeps a box editable when nothing is connected, greyed rather than gone", () => {
    const html = render({ sendsFrom: { email: null, whatsapp: CONNECTED.whatsapp } });
    expect(html.match(/<form/g)).toHaveLength(2);
    // The box's own wrapper, not the kit's `disabled:opacity-60` on a button.
    const GREYED = 'class="flex flex-col gap-3 opacity-60"';
    expect(html).toContain(GREYED);
    expect(html).toContain("Connect a mailbox");
    expect(render()).not.toContain(GREYED);
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

describe("the words that depend on state", () => {
  it("blocks only the out-of-hours switch, and only without opening hours", () => {
    expect(switchBlockedLine({ key: "after_hours" }, false)?.action?.href).toBe(OPENING_HOURS_HREF);
    expect(switchBlockedLine({ key: "after_hours" }, true)).toBeNull();
    expect(switchBlockedLine({ key: "instant_reply" }, false)).toBeNull();
  });

  it("names the connected channels whose instant-reply box is empty, and none when the card is off", () => {
    const halfEmpty: LeadPlaybookDto = {
      ...INSTANT,
      wordings: { ...INSTANT.wordings, whatsapp: null },
    };
    expect(silentChannels([halfEmpty, AFTER_HOURS], CONNECTED)).toEqual(["whatsapp"]);
    // Not connected: nothing to warn about here.
    expect(silentChannels([halfEmpty], { email: CONNECTED.email, whatsapp: null })).toEqual([]);
    // Off: the red line at the top says so instead.
    expect(silentChannels([{ ...halfEmpty, enabled: false }], CONNECTED)).toEqual([]);
    expect(silentChannels([INSTANT], CONNECTED)).toEqual([]);
  });

  it("knows when the instant reply is off, including when the card is missing altogether", () => {
    expect(instantReplyOff([INSTANT, AFTER_HOURS])).toBe(false);
    expect(instantReplyOff([{ ...INSTANT, enabled: false }])).toBe(true);
    expect(instantReplyOff([AFTER_HOURS])).toBe(true);
  });
});
