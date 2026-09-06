import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { BusinessHours } from "@eva/types";
import { describeOpeningHours, readOpeningHoursForm, timeZoneOptions } from "@/lib/opening-hours";

/**
 * The Opening hours screen (slice 3.5a): the form, read and rendered.
 *
 * The action is stubbed for the same reason every screen spec stubs its
 * actions: `next/cache` does not exist in a node test.
 */
vi.mock("@/app/app/settings/opening-hours/actions", () => ({
  saveOpeningHours: async () => ({}),
}));

const { OpeningHoursForm } = await import("@/app/app/settings/opening-hours/opening-hours-form");

const NINE_TO_FIVE: BusinessHours = {
  mon: { open: "09:00", close: "17:00" },
  tue: { open: "09:00", close: "17:00" },
  wed: { open: "09:00", close: "17:00" },
  thu: { open: "09:00", close: "17:00" },
  fri: { open: "09:00", close: "17:00" },
  sat: null,
  sun: null,
};

/** A form as the browser posts it: ticked boxes are "on", the rest absent. */
const form = (fields: Record<string, string>) => (name: string) => fields[name] ?? null;

describe("reading the seven rows", () => {
  it("turns ticked days into ranges and unticked days into closed, every day present", () => {
    const fields: Record<string, string> = {};
    for (const day of ["mon", "tue", "wed", "thu", "fri"]) {
      fields[`open-${day}`] = "on";
      fields[`from-${day}`] = "09:00";
      fields[`to-${day}`] = "17:00";
    }
    // Times typed for a closed day are ignored, not refused.
    fields["from-sat"] = "10:00";
    fields["to-sat"] = "12:00";
    expect(readOpeningHoursForm(form(fields))).toEqual({ hours: NINE_TO_FIVE });
  });

  it("refuses a day that closes before it opens, by name", () => {
    expect(
      readOpeningHoursForm(form({ "open-wed": "on", "from-wed": "17:00", "to-wed": "09:00" })),
    ).toEqual({ error: "Wednesday closes before it opens." });
    expect(
      readOpeningHoursForm(form({ "open-wed": "on", "from-wed": "09:00", "to-wed": "09:00" })),
    ).toEqual({ error: "Wednesday closes before it opens." });
  });

  it("refuses a time that is not a clock time", () => {
    expect(
      readOpeningHoursForm(form({ "open-fri": "on", "from-fri": "9am", "to-fri": "17:00" })),
    ).toEqual({ error: "Friday needs an opening time and a closing time." });
    expect(readOpeningHoursForm(form({ "open-fri": "on" }))).toEqual({
      error: "Friday needs an opening time and a closing time.",
    });
  });

  it("reads a week with nothing ticked as closed every day, not as no hours", () => {
    expect(readOpeningHoursForm(form({}))).toEqual({
      hours: { mon: null, tue: null, wed: null, thu: null, fri: null, sat: null, sun: null },
    });
  });
});

describe("saying when the business is open", () => {
  it("lists every day, open or closed, and says when nothing is set", () => {
    expect(describeOpeningHours(NINE_TO_FIVE)).toBe(
      "Monday 09:00–17:00, Tuesday 09:00–17:00, Wednesday 09:00–17:00, Thursday 09:00–17:00, Friday 09:00–17:00, Saturday closed, Sunday closed.",
    );
    expect(describeOpeningHours(null)).toBe("No opening hours set.");
  });

  it("offers the runtime's zones, with the ones a customer would look for", () => {
    const zones = timeZoneOptions();
    for (const zone of ["Europe/London", "Asia/Dubai", "America/New_York", "UTC"]) {
      expect(zones).toContain(zone);
    }
    expect(zones).toEqual([...zones].sort());
  });
});

describe("the form, rendered", () => {
  const render = (props: Partial<Parameters<typeof OpeningHoursForm>[0]> = {}) =>
    renderToStaticMarkup(
      <OpeningHoursForm
        organisationId="org-1"
        timezone="Asia/Dubai"
        hours={NINE_TO_FIVE}
        {...props}
      />,
    );

  /** The `<option>` for one zone. Attribute order is React's business, not ours. */
  const optionFor = (html: string, zone: string): string =>
    html.match(new RegExp(`<option[^>]*value="${zone.replace("/", "\\/")}"[^>]*>`))?.[0] ?? "";

  it("pre-selects the organisation's zone and ticks the open days", () => {
    const html = render();
    expect(optionFor(html, "Asia/Dubai")).toContain("selected");
    expect(optionFor(html, "Europe/London")).not.toContain("selected");
    expect(html.match(/type="checkbox"/g)).toHaveLength(7);
    expect(html.match(/checked=""/g)).toHaveLength(5);
    expect(html).toContain('name="from-mon"');
    expect(html).toContain('value="09:00"');
    expect(html).toContain("Remove opening hours");
    // The consequence for the other product, said before the change.
    expect(html).toContain("invoice");
  });

  it("offers nothing to remove when there are no hours, and ticks nothing", () => {
    const html = render({ hours: null, timezone: "Europe/London" });
    expect(html).not.toContain("Remove opening hours");
    expect(html).not.toMatch(/checked=""/);
    expect(optionFor(html, "Europe/London")).toContain("selected");
  });
});
