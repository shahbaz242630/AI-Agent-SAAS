import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Home from "@/app/page";
import {
  FAQ,
  FOOTER,
  HERO,
  HERO_EXAMPLE,
  PLACEHOLDER,
  PRICING,
  TESTIMONIALS,
  TRUST,
} from "@/app/landing-copy";

/**
 * The landing page — the one screen a stranger meets before deciding whether
 * this product tells the truth.
 *
 * ⚠️ THE INTERESTING HALF OF THIS FILE IS NOT THE LAYOUT. It is the four things
 * the design handoff arrived carrying that are not ours to say: invented
 * testimonials, a price nobody has costed, legal documents that do not exist,
 * and a data-residency claim that is false. Each is fine to SHOW while it is
 * visibly unfinished, and each becomes a lie the moment it stops looking
 * unfinished. That is what these tests hold.
 */

const html = (): string => renderToStaticMarkup(<Home />);

describe("the landing page renders and lets people in", () => {
  it("puts the visitor one click from an account, from the bar and the hero", () => {
    const markup = html();

    expect(markup).toContain('href="/sign-up"');
    expect(markup).toContain('href="/sign-in"');
    expect(markup).toContain(HERO.headline);
  });

  /**
   * ⚠️ THE HEALTH BADGE IS GONE AND MUST STAY GONE. The Phase 0 scaffold showed
   * "API connected · eva-api v0.0.0" to the public: a developer's diagnostic
   * that tells a visitor nothing they want, and tells anyone curious what our
   * stack is and which version is running.
   */
  it("shows no internal diagnostics to the public", () => {
    const markup = html();

    expect(markup).not.toContain("API connected");
    expect(markup).not.toContain("eva-api");
  });
});

describe("what the page may not claim", () => {
  /**
   * ⚠️ THE DESIGN SAYS "Data hosted in London, UK". It is not true: the
   * database is in London and every scrap of compute is in the USA
   * (`us-west2`, `us-east-1`), so invoice contents, client names and reminder
   * bodies are all processed outside the UK — international transfers under UK
   * GDPR, and exactly the fact a cautious buyer picks a supplier on. Founder
   * ruling 2026-08-10: say the literally true thing instead.
   */
  it("never claims the data is hosted in the UK", () => {
    const markup = html();

    expect(markup).not.toContain("Data hosted in London");
    expect(TRUST).toContain("Eva’s database runs in London");
    for (const claim of TRUST) {
      expect(claim).not.toMatch(/hosted in the UK|UK-hosted|stored in the UK/i);
    }
  });

  it("does not answer the data question with a blanket “in the UK”", () => {
    const answer = FAQ.find((entry) => entry.question === "Where is my data kept?")?.answer ?? "";

    expect(answer).toContain("London");
    // The processing is named rather than left for someone to discover.
    expect(answer).toMatch(/outside the UK/i);
  });

  /**
   * ⚠️ "No card needed" was cut from the auth pages on 2026-08-10 and must not
   * creep back in through the front door. It is a promise about a billing
   * system that does not exist, made to somebody deciding whether we are
   * honest.
   */
  it("promises nothing about billing", () => {
    const markup = html();

    expect(markup).not.toMatch(/no card needed/i);
    expect(markup).not.toMatch(/free forever|cancel any time/i);
  });
});

describe("everything undecided still looks undecided", () => {
  /**
   * ⚠️ THE POINT OF THE WHOLE FILE. A realistic-looking fake is the kind that
   * survives to launch — it reads fine, so nobody stops on it. If someone
   * writes a plausible quote here without a real person behind it, this fails.
   */
  it("marks every testimonial as a placeholder, in the copy and on the screen", () => {
    const markup = html();

    for (const testimonial of TESTIMONIALS) {
      expect(testimonial.quote).toMatch(/placeholder/i);
      expect(testimonial.caption).toContain(PLACEHOLDER);
      expect(markup).toContain(testimonial.caption);
    }
  });

  it("marks the price as a placeholder wherever the number appears", () => {
    const markup = html();

    expect(PRICING.marker).toContain(PLACEHOLDER);
    // The marker must render, not merely exist in the data.
    expect(markup).toContain(PRICING.marker);
    expect(markup).toContain(PRICING.amount);
  });

  it("says out loud that there is nothing behind Privacy and Terms", () => {
    const markup = html();
    const legal = FOOTER.columns.find((column) => column.heading === "Legal");

    expect(legal?.items).toEqual(["Privacy", "Terms"]);
    expect(FOOTER.legalNote).toContain(PLACEHOLDER);
    expect(markup).toContain(FOOTER.legalNote);
    // ⚠️ Text, not links: a Privacy link that 404s on a page collecting
    // sign-ups is worse than no link at all.
    expect(markup).not.toContain('href="/privacy"');
    expect(markup).not.toContain('href="/terms"');
  });

  /**
   * ⚠️ THE HERO'S FIGURES ARE INVENTED. The identical three cards were deleted
   * from the auth pages, where a number beside a sign-in form reads as the
   * visitor's own. On a landing page a labelled example is the normal way to
   * show software — the label is the entire difference between an illustration
   * and a claim about somebody's real book.
   */
  it("labels the example figures as an example", () => {
    const markup = html();

    expect(HERO_EXAMPLE.label).toBe("Example");
    expect(markup).toContain(HERO_EXAMPLE.label);
    expect(markup).toContain(HERO_EXAMPLE.total);
    // The label must sit in the same panel as the number it qualifies.
    const panel = markup.slice(
      markup.indexOf(HERO_EXAMPLE.label),
      markup.indexOf(HERO_EXAMPLE.total),
    );
    expect(panel.length).toBeGreaterThan(0);
  });

  /**
   * The trust strip is the one place a reader takes at face value, so it may
   * carry no counts at all — "trusted by 200 businesses" is the shape of claim
   * that gets invented first, and we have no customers.
   */
  it("keeps invented numbers out of the trust strip", () => {
    for (const claim of TRUST) {
      expect(claim, `"${claim}" states a figure`).not.toMatch(/\d/);
    }
  });
});
