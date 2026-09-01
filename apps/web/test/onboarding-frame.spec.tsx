import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OnboardingFrame } from "@/app/app/onboarding/onboarding-frame";

/**
 * Setup's frame, actually rendered (2026-08-09 design handoff, slice 1.10d).
 *
 * ⚠️ THE STEPPER IS THE PART THAT CAN BE WRONG WITHOUT LOOKING WRONG. Every
 * disc renders, every label renders, and the screen looks finished whichever
 * one is amber — so an off-by-one here ships. `page.tsx` derives the number
 * from server state and this component draws it; the derivation is covered by
 * the page's own branches, and the drawing is covered here.
 *
 * The path in through `renderToStaticMarkup` is the `SidebarBody` precedent: no
 * DOM, no new dependency, and the reason the component takes the step as a prop
 * rather than reading it from a hook.
 */

// No apostrophe: `renderToStaticMarkup` escapes one to `&#x27;`, and a test that
// fails on correct markup is worse than no test.
const PANE_TITLE = "The heading of the pane";

const render = (current: 1 | 2, organisationName: string | null = null) =>
  renderToStaticMarkup(
    <OnboardingFrame
      current={current}
      organisationName={organisationName}
      email="sam.okafor@northgate.co.uk"
      signOutSlot={<span>Sign out</span>}
      paneTitle={PANE_TITLE}
    >
      <p>the step itself</p>
    </OnboardingFrame>,
  );

/**
 * What the rail says about one step, in the words a screen reader hears.
 *
 * Order-based rather than markup-based on purpose: the status sits immediately
 * before its label, and asserting the exact tags between them would fail on
 * markup that is perfectly correct. A test that breaks when nothing is wrong
 * gets deleted by the next person, and takes its real coverage with it.
 */
function statusOf(html: string, label: string): string {
  const at = html.indexOf(`>${label}<`);
  if (at < 0) return "missing";
  const preceding = html.slice(0, at).match(/Completed:|Current step:|Not started:/g) ?? [];
  return preceding[preceding.length - 1] ?? "none";
}

describe("the setup frame", () => {
  /**
   * ⚠️ THE REASON THE RAIL EXISTS. The screen it replaced showed a bar with a
   * label, so a customer on step one could see that a later step existed but
   * not what it wanted. Naming each one up front is what makes it expected.
   */
  it("names every step, and what each is for, from the very first one", () => {
    const html = render(1);
    expect(html).toContain("Your business");
    expect(html).toContain("What should we call you?");
    expect(html).toContain("Done");
  });

  /**
   * ⚠️ THE MAILBOX STEP IS GONE AND MUST STAY GONE (founder ruling
   * 2026-09-01). A mailbox belongs to one product, and setup runs before a
   * product is chosen — so asking here could only guess on the customer's
   * behalf. Asserted rather than assumed: putting the step back is a one-line
   * change to `STEPS`, and nothing else in this file would notice.
   */
  it("does not ask for a mailbox", () => {
    const html = render(1) + render(2, "Northgate Plumbing");
    expect(html).not.toContain("Your mailbox");
    expect(html).not.toContain("Where Eva sends from");
  });

  it("marks exactly one step as the current one", () => {
    for (const step of [1, 2] as const) {
      expect(render(step).match(/aria-current="step"/g)).toHaveLength(1);
    }
  });

  /** The off-by-one, stated twice because it is the whole point. */
  it("puts the tick behind you and the ring on where you are", () => {
    const first = render(1);
    expect(statusOf(first, "Your business")).toBe("Current step:");
    expect(statusOf(first, "Done")).toBe("Not started:");

    const second = render(2, "Northgate Plumbing");
    expect(statusOf(second, "Your business")).toBe("Completed:");
    expect(statusOf(second, "Done")).toBe("Current step:");
  });

  /**
   * ⚠️ COLOUR IS NOT AN ANSWER ON ITS OWN, but it is the answer most people
   * read — a green tick behind and an amber ring on the step you are at. These
   * pin the two discs to their tokens, because `bg-accent` on a finished step
   * would say "you still have this to do" to everyone who is not using a
   * screen reader.
   */
  it("uses the green disc for done and the amber ring for now", () => {
    const second = render(2);
    expect(second).toContain("bg-module-live");
    expect(second).toContain("shadow-[var(--shadow-step)]");
    // One tick behind, one ring on: not two rings, not two ticks.
    expect(second.match(/bg-module-live/g)).toHaveLength(1);
    expect(second.match(/shadow-\[var\(--shadow-step\)\]/g)).toHaveLength(1);
  });

  /** Step one stops asking the question once it has the answer. */
  it("shows the business back to you once it is named", () => {
    expect(render(1)).toContain("What should we call you?");
    expect(render(1)).not.toContain("Northgate Plumbing");

    const named = render(2, "Northgate Plumbing");
    expect(named).toContain("Northgate Plumbing");
    expect(named).not.toContain("What should we call you?");
  });

  /**
   * ⚠️ "BACK" LEAVES SETUP; IT DOES NOT MEAN "THE PREVIOUS STEP". The design
   * sends a later step back to step one, and this flow cannot: by then the
   * organisation exists and nothing renames one. On the last step setup is over
   * and the pane offers a real destination, so another pointing outwards would
   * only be a way to lose somebody who has just finished.
   */
  it("offers a way out of setup on the unfinished steps, and none on the last", () => {
    expect(render(1)).toContain("← Back");
    expect(render(2)).not.toContain("← Back");
  });

  it("says which account this is, since there is no sidebar to say it", () => {
    const html = render(1);
    expect(html).toContain("sam.okafor@northgate.co.uk");
    expect(html).toContain("Sign out");
  });

  it("renders the step's own pane, heading and all", () => {
    const html = render(1);
    expect(html).toContain(PANE_TITLE);
    expect(html).toContain("the step itself");
  });

  /** The two facts worth knowing before handing a product access to your email. */
  it("keeps the reassurances on every step", () => {
    for (const step of [1, 2] as const) {
      expect(render(step)).toContain("never a third-party address");
      expect(render(step)).toContain("never chases more than what&#x27;s left");
    }
  });
});
