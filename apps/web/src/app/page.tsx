import Link from "next/link";
import {
  FAQ,
  FEATURES,
  FOOTER,
  HERO,
  HERO_EXAMPLE,
  MODULES,
  PRICING,
  STEPS,
  TESTIMONIALS,
  TRUST,
} from "./landing-copy";

/**
 * The landing page (design handoff §1, built 2026-08-11).
 *
 * ⚠️ WHAT WAS HERE BEFORE WAS A PHASE 0 SCAFFOLD — a wordmark, two buttons and
 * a live API health badge, facing the public. The badge is gone: "API connected
 * · eva-api v0.0.0" tells a visitor nothing they want and tells anyone curious
 * what our stack is and which version of it is running.
 *
 * ⚠️ THE WORDS LIVE IN `landing-copy.ts`, NOT HERE. Four things on this page
 * are not ours to say yet — testimonials, a price, legal documents, and where
 * the data is processed — and a sentence typed into markup is a sentence
 * nobody audits. `landing-copy.spec.ts` reads that file and insists every
 * undecided value is still visibly marked as undecided.
 *
 * ⚠️ TWO DEPARTURES FROM THE HANDOFF, BOTH DELIBERATE, BOTH RECORDED:
 * 1. Money is set in the BODY face. The design asks for Bricolage at 44px;
 *    Bricolage renders £ malformed, and sterling is the launch market's
 *    currency (verified 2026-08-09 — $ and € are fine, £ alone is not).
 * 2. The trust strip says "Eva's database runs in London", not "Data hosted in
 *    London, UK". All compute is in the USA. Founder ruling 2026-08-10.
 */

const SHELL = "mx-auto w-full max-w-[1180px] px-6 sm:px-8";

export default function Home() {
  return (
    <div className="flex flex-1 flex-col bg-background">
      <MarketingBar />
      <main className="flex flex-1 flex-col">
        <Hero />
        <Modules />
        <Steps />
        <Features />
        <Testimonials />
        <Pricing />
        <TrustStrip />
        <Faq />
      </main>
      <Footer />
    </div>
  );
}

/** The wordmark reused from the auth pages, so the front door and the sign-in
 *  page are recognisably the same product. */
function Wordmark({ size = "text-[23px]" }: { size?: string }) {
  return (
    <span className="flex items-baseline gap-0.5">
      <span className={`font-display ${size} font-bold`}>eva</span>
      <span aria-hidden className="size-1.5 rounded-full bg-accent" />
    </span>
  );
}

function MarketingBar() {
  return (
    <header className="sticky top-0 z-20 border-b border-border bg-background">
      <div className={`${SHELL} flex items-center gap-7 py-4`}>
        <Link href="/" aria-label="Eva home">
          <Wordmark />
        </Link>
        <div className="flex-1" />
        <nav className="flex items-center gap-3.5">
          <Link
            href="/sign-in"
            className="text-[13.5px] font-semibold text-label hover:text-foreground"
          >
            Sign in
          </Link>
          {/* "Sign up", not "Get started" — the founder, walking it on
              2026-09-05: a new visitor looks for the word and it was nowhere
              on the page. The hero keeps its own "Get started free". */}
          <Link
            href="/sign-up"
            className="rounded-[var(--radius-control)] bg-primary px-4.5 py-2.5 text-[13px] font-semibold text-primary-foreground shadow-[var(--shadow-primary)]"
          >
            Sign up
          </Link>
        </nav>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section className={`${SHELL} flex flex-col items-center gap-12 py-14 lg:flex-row lg:py-20`}>
      <div className="flex flex-1 flex-col gap-5.5">
        <p className="text-xs font-bold tracking-[0.1em] text-link uppercase">{HERO.eyebrow}</p>
        <h1 className="font-display text-[38px] leading-[1.06] font-semibold tracking-[-0.015em] text-pretty sm:text-[52px]">
          {HERO.headline}
        </h1>
        <p className="max-w-[480px] text-[17px] leading-[1.55] text-muted-foreground">
          {HERO.lead}
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Link
            href="/sign-up"
            className="rounded-[var(--radius-control)] bg-primary px-6.5 py-3.5 text-[15px] font-semibold text-primary-foreground shadow-[var(--shadow-primary)]"
          >
            {HERO.primaryCta}
          </Link>
          <a
            href="#how-it-works"
            className="rounded-[var(--radius-control)] border border-input-border bg-surface px-6.5 py-3.5 text-[15px] font-semibold hover:bg-row-hover"
          >
            {HERO.secondaryCta}
          </a>
        </div>
        <p className="text-[12.5px] text-faint">{HERO.reassurance}</p>
      </div>

      <HeroExample />
    </section>
  );
}

/**
 * ⚠️ LABELLED "EXAMPLE", AND THE LABEL IS LOAD-BEARING. The same three cards
 * were deleted from the auth pages, where a figure beside a sign-in form reads
 * as the visitor's own. Here they are how software is normally shown — but
 * £18,420.50 is a number we made up, so the page says so out loud rather than
 * leaving a stranger to assume it is somebody's real book, or ours.
 */
function HeroExample() {
  return (
    <div
      className="flex w-full flex-1 flex-col gap-3.5 rounded-[var(--radius-panel)] p-7 sm:p-9"
      style={{
        backgroundImage:
          "linear-gradient(160deg, var(--color-hero-wash-from), var(--color-hero-wash-to))",
      }}
    >
      <p className="self-start rounded-[var(--radius-pill)] bg-surface/80 px-2.5 py-1 text-[10.5px] font-bold tracking-[0.07em] text-faint uppercase">
        {HERO_EXAMPLE.label}
      </p>

      <div className="flex flex-col gap-0.5 rounded-[var(--radius-card)] border border-border bg-surface px-5.5 py-4.5">
        <p className="text-[11px] font-bold tracking-[0.07em] text-faint uppercase">
          {HERO_EXAMPLE.totalCaption}
        </p>
        {/* Body face, not Bricolage — see the file header. */}
        <p className="text-[34px] leading-tight font-semibold">{HERO_EXAMPLE.total}</p>
        <p className="text-[12.5px] text-muted-foreground">{HERO_EXAMPLE.totalDetail}</p>
      </div>

      <div className="flex items-center gap-3 rounded-[var(--radius-control)] border border-border border-l-[3px] border-l-success bg-surface px-4.5 py-3.5">
        <span className="rounded-[var(--radius-pill)] bg-success-tint px-2.5 py-0.5 text-[11px] font-semibold text-success">
          {HERO_EXAMPLE.sentChip}
        </span>
        <p className="text-[12.5px] text-label">{HERO_EXAMPLE.sentLine}</p>
      </div>

      <div className="flex items-center gap-3 rounded-[var(--radius-control)] border border-border bg-surface px-4.5 py-3.5">
        <span aria-hidden className="size-2 shrink-0 rounded-full bg-accent" />
        <p className="text-[12.5px] text-label">{HERO_EXAMPLE.paidLine}</p>
      </div>
    </div>
  );
}

function SectionTitle({ children, id }: { children: React.ReactNode; id?: string }) {
  return (
    <h2 {...(id ? { id } : {})} className="font-display text-[30px] font-semibold text-pretty">
      {children}
    </h2>
  );
}

function Modules() {
  return (
    <section className={`${SHELL} flex flex-col gap-7 pb-18`}>
      <SectionTitle>One employee, three jobs.</SectionTitle>
      <div className="grid gap-4 md:grid-cols-3">
        {MODULES.map((module) => (
          <div
            key={module.name}
            className={`flex flex-col gap-2.5 rounded-[var(--radius-panel)] px-7 py-6.5 ${
              module.live ? "bg-sidebar" : "border border-border bg-surface"
            }`}
          >
            <div className="flex items-center justify-between gap-3">
              <h3
                className={`font-display text-[19px] font-semibold ${
                  module.live ? "text-sidebar-foreground" : ""
                }`}
              >
                {module.name}
              </h3>
              <span
                className={`rounded-[var(--radius-pill)] px-2.5 py-0.5 text-[10.5px] font-bold tracking-[0.05em] uppercase ${
                  module.live
                    ? "bg-accent text-accent-foreground"
                    : "border border-neutral-border text-faint"
                }`}
              >
                {module.status}
              </span>
            </div>
            <p
              className={`text-[13.5px] leading-[1.55] ${
                module.live ? "text-sidebar-muted" : "text-muted-foreground"
              }`}
            >
              {module.body}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

function Steps() {
  return (
    <section className="border-y border-border bg-surface">
      <div className={`${SHELL} flex flex-col gap-8 py-16`}>
        <SectionTitle id="how-it-works">Set up in an afternoon tea break.</SectionTitle>
        <ol className="grid gap-10 md:grid-cols-3">
          {STEPS.map((step, index) => (
            <li key={step.title} className="flex flex-col gap-2.5">
              <span
                aria-hidden
                className="flex size-8 items-center justify-center rounded-full bg-accent text-[15px] font-bold text-accent-foreground"
              >
                {index + 1}
              </span>
              <h3 className="text-[15.5px] font-bold">{step.title}</h3>
              <p className="text-[13.5px] leading-[1.55] text-muted-foreground">{step.body}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function Features() {
  return (
    <section className={`${SHELL} flex flex-col gap-12 py-16 lg:flex-row`}>
      <div className="flex flex-1 flex-col gap-4.5">
        <SectionTitle>Built like a careful bookkeeper, not a spam cannon.</SectionTitle>
        <p className="text-sm leading-[1.6] text-muted-foreground">
          Eva’s rules are boring on purpose — that’s what makes her safe to leave running.
        </p>
      </div>
      <div className="grid flex-[1.4] gap-3.5 sm:grid-cols-2">
        {FEATURES.map((feature) => (
          <div
            key={feature.title}
            className="flex flex-col gap-1.5 rounded-[var(--radius-card)] border border-border bg-surface px-5.5 py-5"
          >
            <h3 className="text-sm font-bold">{feature.title}</h3>
            <p className="text-[13px] leading-[1.5] text-muted-foreground">{feature.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

/** Striped disc where a face would be — the design's way of saying "nobody is
 *  here yet" without drawing a person who does not exist. */
function PlaceholderAvatar({ id }: { id: string }) {
  return (
    <svg width="40" height="40" viewBox="0 0 40 40" aria-hidden className="shrink-0">
      <defs>
        <pattern
          id={id}
          width="6"
          height="6"
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(45)"
        >
          <rect width="6" height="6" fill="var(--color-muted)" />
          <rect width="3" height="6" fill="var(--color-neutral-border)" />
        </pattern>
      </defs>
      <circle cx="20" cy="20" r="20" fill={`url(#${id})`} />
    </svg>
  );
}

function Testimonials() {
  return (
    <section className={`${SHELL} grid gap-4 pb-18 sm:grid-cols-2`}>
      {TESTIMONIALS.map((testimonial, index) => (
        <figure
          key={testimonial.quote}
          className="flex flex-col gap-4 rounded-[var(--radius-panel)] border border-border bg-surface px-7 py-6.5"
        >
          <blockquote className="text-[14.5px] leading-[1.6] text-label italic">
            “{testimonial.quote}”
          </blockquote>
          <figcaption className="flex items-center gap-3">
            <PlaceholderAvatar id={`testimonial-stripe-${index}`} />
            <span className="flex flex-col">
              <span className="text-[13px] font-bold">{testimonial.name}</span>
              <span className="font-mono text-[11px] text-faint">{testimonial.caption}</span>
            </span>
          </figcaption>
        </figure>
      ))}
    </section>
  );
}

function Pricing() {
  return (
    <section className={`${SHELL} pb-18`}>
      <div className="flex flex-col items-start gap-6 rounded-[var(--radius-panel)] bg-sidebar px-8 py-10 sm:px-12 lg:flex-row lg:items-center lg:gap-10">
        <div className="flex flex-1 flex-col gap-2.5">
          <h2 className="font-display text-[27px] font-semibold text-sidebar-foreground">
            {PRICING.headline}
          </h2>
          <p className="text-sm leading-[1.55] text-sidebar-muted">
            {PRICING.body}{" "}
            <span className="font-mono text-xs text-sidebar-fainter">{PRICING.marker}</span>
          </p>
        </div>
        {/* Body face, not Bricolage — the £ would render malformed. */}
        <p className="flex items-baseline gap-1.5">
          <span className="text-[44px] leading-none font-semibold text-sidebar-foreground">
            {PRICING.amount}
          </span>
          <span className="text-sm text-sidebar-muted">{PRICING.period}</span>
        </p>
        <Link
          href="/sign-up"
          className="rounded-[var(--radius-control)] bg-accent px-6 py-3.5 text-[14.5px] font-bold text-accent-foreground"
        >
          {PRICING.cta}
        </Link>
      </div>
    </section>
  );
}

function TrustStrip() {
  return (
    <section className={`${SHELL} flex flex-wrap justify-center gap-x-9 gap-y-3 pb-18`}>
      {TRUST.map((fact) => (
        <span key={fact} className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
          <span aria-hidden className="size-[7px] rounded-full bg-success" />
          {fact}
        </span>
      ))}
    </section>
  );
}

function Faq() {
  return (
    <section className="border-t border-border bg-surface">
      <div className={`${SHELL} flex flex-col gap-7 py-16`}>
        <h2 className="font-display text-[26px] font-semibold">Questions people ask about Eva</h2>
        <dl className="grid gap-7 sm:grid-cols-2 sm:gap-x-12">
          {FAQ.map((entry) => (
            <div key={entry.question} className="flex flex-col gap-1.5">
              <dt className="text-sm font-bold">{entry.question}</dt>
              <dd className="text-[13px] leading-[1.55] text-muted-foreground">{entry.answer}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="bg-sidebar text-sidebar-muted">
      <div className={`${SHELL} flex flex-col gap-10 py-12 sm:flex-row sm:gap-16`}>
        <div className="flex flex-[1.2] flex-col gap-2.5">
          <span className="text-sidebar-foreground">
            <Wordmark size="text-[22px]" />
          </span>
          <p className="max-w-[280px] text-[12.5px] leading-[1.5]">{FOOTER.tagline}</p>
        </div>
        {FOOTER.columns.map((column) => (
          <div key={column.heading} className="flex flex-col gap-2.5 text-[12.5px]">
            <h2 className="text-[11px] font-bold tracking-[0.08em] text-sidebar-fainter uppercase">
              {column.heading}
            </h2>
            {column.items.map((item) => (
              <span key={item}>{item}</span>
            ))}
            {/* ⚠️ Not links. Neither document exists, and a Privacy link that
                404s on a page collecting sign-ups is worse than no link. */}
            {column.heading === "Legal" && (
              <span className="font-mono text-[10.5px] text-sidebar-fainter">
                {FOOTER.legalNote}
              </span>
            )}
          </div>
        ))}
      </div>
      <div className={`${SHELL} pb-8 text-[11.5px] text-sidebar-fainter`}>{FOOTER.copyright}</div>
    </footer>
  );
}
