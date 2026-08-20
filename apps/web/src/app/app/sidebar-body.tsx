import Link from "next/link";
import { MODULE_CATALOGUE, MODULE_KEYS, moduleHref, type ModuleKey } from "@eva/types";
import { NAV_ITEMS, PRODUCT_NAV, isActiveSection, productForPath } from "@/lib/navigation";
import { NAV_ICONS } from "./nav-icons";
import { UserMenu } from "./user-menu";

/**
 * The sidebar's markup, with the current path as an ARGUMENT (2026-08-09).
 *
 * ⚠️ SPLIT OUT SO IT CAN BE RENDERED IN A TEST. `AppSidebar` reads the path
 * from `usePathname`, and a hook makes a component unrenderable in a plain node
 * test — which would leave the whole shell, the first thing on every signed-in
 * screen, covered by nothing. Taking the path as a prop is the entire
 * difference between testable and not. Same move as `bookMoneyPanel`, and for
 * the same reason: when something is easy to get wrong and impossible to see,
 * put it where a test can reach it.
 *
 * Hook-free and directive-free on purpose — the `ReminderStepList` precedent —
 * so `renderToStaticMarkup` needs no DOM and no new dependency.
 */
export interface SidebarIdentity {
  /** Needed to ask which products the organisation holds. `null` when unknown. */
  organisationId: string | null;
  /** `null` when the fetch failed or the account has no organisation yet. */
  organisation: { name: string; initials: string; roleLabel: string } | null;
  user: { name: string; email: string; initials: string };
}

/**
 * The modules, live first. The `soon` ones are named so the shape is honest.
 *
 * ⚠️ THIS USED TO BE A HAND-WRITTEN LIST OF THREE and it had drifted from the
 * settings screen in every way a list can (found by walking, 2026-08-18): it
 * omitted Voice Credit Control entirely, and it called the other two "Lead
 * Follow-up" and "AI Reception" where settings said "Lead Follow-Up" and "AI
 * Receptionist". Two screens, one product, three disagreements. Derived from
 * `MODULE_CATALOGUE` now, so a product cannot exist in one place and not the
 * other and cannot be called two things.
 */
const MODULES: readonly { key: ModuleKey; label: string; live: boolean }[] = MODULE_KEYS.map(
  (key) => ({
    key,
    label: MODULE_CATALOGUE[key].name,
    live: MODULE_CATALOGUE[key].live,
  }),
);

export function SidebarBody({
  pathname,
  identity,
  heldModules,
  signOutSlot,
}: {
  pathname: string;
  identity: SidebarIdentity;
  /**
   * The products this organisation actually holds.
   *
   * ⚠️ THIS PROP EXISTS BECAUSE THE SIDEBAR WAS LYING (found by walking,
   * 2026-08-19). It rendered a live dot from `MODULE_CATALOGUE[key].live`,
   * which means "we have built this" — not "you have this". So with Invoice
   * Chasing switched OFF, the sidebar showed it lit while `/app/invoices` three
   * inches away said "Outdoor and gardening doesn't have Invoice Chasing". Two
   * statements, one screen, and the same failure family as the money bug.
   *
   * ⚠️ `null` MEANS "WE COULD NOT FIND OUT", AND IT IS NOT THE SAME AS `[]`.
   * The shell swallows its own fetch failures (a shell that 500s takes every
   * screen with it), so a failed read must not render as "you own nothing" —
   * that would be a fresh lie replacing the old one. Unknown shows the product
   * name with no dot and no badge: we claim nothing we cannot support.
   */
  heldModules: readonly string[] | null;
  /**
   * The sign-out control, passed in rather than built here. It is a form bound
   * to a server action, and a server action cannot be constructed inside a
   * plain test — so the one piece that cannot be rendered offline is the one
   * piece this component does not own.
   */
  signOutSlot: React.ReactNode;
}) {
  /** Null on a platform screen (the hub, Clients, Settings). */
  const currentProduct = productForPath(pathname);

  return (
    <nav
      aria-label="Sections"
      className="sticky top-0 flex h-screen w-[236px] shrink-0 flex-col bg-sidebar px-4 pt-[22px] pb-[18px] text-sidebar-body"
    >
      <Link href="/" className="flex items-baseline gap-0.5 px-2">
        <span className="font-display text-2xl font-bold text-sidebar-foreground">eva</span>
        <span aria-hidden className="size-[7px] rounded-full bg-accent" />
      </Link>
      <p className="px-2 pt-0.5 text-[11px] text-sidebar-faint">AI credit control</p>

      {/* Absent for a brand-new account, which has no organisation until
          onboarding creates one — an empty chip would be a hole in the chrome. */}
      {identity.organisation && (
        <div className="mt-[18px] flex items-center gap-2.5 rounded-[var(--radius-control)] border border-sidebar-border bg-sidebar-panel px-2.5 py-2.5">
          <span
            aria-hidden
            className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-accent text-xs font-bold text-accent-foreground"
          >
            {identity.organisation.initials}
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-[12.5px] font-semibold text-sidebar-foreground">
              {identity.organisation.name}
            </span>
            <span className="text-[10.5px] text-sidebar-faint">
              {identity.organisation.roleLabel}
            </span>
          </span>
        </div>
      )}

      {/**
       * ⚠️ THE SECTIONS DEPEND ON WHERE YOU ARE, not on a single flat list.
       * Inside a product you get that product's screens; everywhere you get the
       * platform's. Before 2026-08-19 one list held Home, Invoices, Clients and
       * Chasing — three of which belong to invoice chasing — so a customer who
       * bought only a lead product would have been offered three dead ends.
       */}
      <ul className="mt-5 flex flex-col gap-0.5">
        {[
          ...(currentProduct ? (PRODUCT_NAV[currentProduct] ?? []) : []),
          /**
           * ⚠️ "ALL PRODUCTS" IS ALWAYS SHOWN, AND THE REASON IT ONCE WAS NOT
           * IS THE REASON IT MUST BE NOW.
           *
           * It used to be hidden for a customer holding exactly one product,
           * because `/app` sent them straight back into that product and a link
           * that cannot change anything reads as broken. **The founder reversed
           * that skip on 2026-08-20** — everybody lands on the hub now — so the
           * link goes somewhere real for everyone, and hiding it would strand a
           * one-product customer inside their product with no way back to the
           * screen they were explicitly asked to be able to reach.
           *
           * ⚠️ TWO HALVES OF ONE PROMISE IN TWO FILES: removing the skip in
           * `app/page.tsx` without this line would have shipped exactly half a
           * fix, and nothing would have failed. Found by looking, not by tests.
           */
          ...NAV_ITEMS,
        ].map((item) => {
          const active = isActiveSection(pathname, item.href);
          const Icon = NAV_ICONS[item.href];
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                title={item.description}
                /* Colour alone is not an answer to "where am I" — the current
                   section is named for a screen reader too. */
                aria-current={active ? "page" : undefined}
                className={`flex items-center gap-2.5 rounded-[9px] px-2.5 py-2.5 text-[13.5px] ${
                  active
                    ? "bg-sidebar-active font-semibold text-sidebar-foreground"
                    : "font-medium text-sidebar-muted hover:bg-sidebar-hover"
                }`}
              >
                {Icon && <Icon className={active ? "text-accent" : undefined} />}
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>

      <div className="mt-[22px] flex flex-col gap-2 border-t border-sidebar-border pt-4">
        {/* ⚠️ "Products", not "Modules" (2026-08-11). `module` is the
            database's word — `organisation_modules` — and it had leaked onto
            the one surface every signed-in screen shows. Settings says
            "Your products"; so does this now. */}
        <h2 className="px-2.5 text-[10.5px] font-bold tracking-[0.08em] text-sidebar-fainter uppercase">
          Products
        </h2>
        <ul className="flex flex-col gap-2">
          {MODULES.map((module) => {
            /**
             * Four states, and they are four different sentences:
             *   not built, not held → "soon" (ours to finish; nothing to buy)
             *   not built, HELD     → "soon" (you have it; it does not exist
             *                                 yet, so there is nowhere to go)
             *   built, held         → dot    (you have this, it is running)
             *   built, not held     → "off"  (you could have this; you have not)
             * Unknown (`heldModules === null`) renders as none of them.
             */
            const held = heldModules === null ? null : heldModules.includes(module.key);
            /**
             * ⚠️ THERE ARE FOUR STATES, NOT THREE — the list above missed
             * "HELD AND NOT BUILT", and that gap was a 404 on production.
             *
             * This branch used to ask `held === true` alone, so holding a
             * product outranked our having built it. The founder's own
             * organisation holds `voice_credit_controller` — a row left over
             * from before the phantom-products fix, when the screen still
             * offered unbuilt products — and the sidebar therefore rendered a
             * live dot linking to `/app/voice-credit-control`, which is not a
             * route. Not our error page: a bare Next 404, no sidebar, no way
             * back. Walked and reproduced on production 2026-08-19.
             *
             * Entering a product needs BOTH: they hold it, and it exists.
             * The badge keeps saying "soon", which is what the Products screen
             * says about the same product on the same page load.
             */
            const enterable = held === true && module.live;
            const badge = !module.live ? "soon" : held === false ? "off" : null;
            return (
              <li
                key={module.key}
                className={`flex items-center gap-2 px-2.5 py-[3px] text-[12.5px] ${
                  enterable ? "text-sidebar-body" : "justify-between text-sidebar-fainter"
                }`}
              >
                {enterable ? (
                  /* Held products are the way INTO them — the list was inert
                     text before the hub existed, which meant the only route to
                     a product you owned was a nav item three inches above. */
                  <Link href={moduleHref(module.key)} className="flex items-center gap-2">
                    <span aria-hidden className="size-[7px] rounded-full bg-module-live" />
                    {module.label}
                  </Link>
                ) : (
                  <>
                    {module.label}
                    {/* A badge rather than a hidden row: naming what is coming —
                        or what is switched off — is honest, and a customer who
                        wants it can ask for it. Hiding leaves somebody unable to
                        tell "not built" from "not bought". */}
                    {badge && (
                      <span className="rounded-[var(--radius-pill)] border border-sidebar-chip-border px-[7px] py-px text-[10px] font-semibold">
                        {badge}
                      </span>
                    )}
                  </>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      <div className="flex-1" />

      {/* ⚠️ THREE THINGS UNDER ONE NAME, INSTEAD OF TWO ANONYMOUS ICONS
          (founder, 2026-08-18). Change password and sign out used to sit here
          as bare glyphs beside the user's name, and Settings was a nav section
          above. They are all about the PERSON rather than the business, so they
          are one menu now — opening upwards, because this card is at the bottom
          of the screen. `UserMenu` owns the disclosure; this file stays
          hook-free so it can still be rendered in a plain node test. */}
      <UserMenu user={identity.user} signOutSlot={signOutSlot} />
    </nav>
  );
}
