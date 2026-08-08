/**
 * The signed-in app's navigation (Slice 1.9).
 *
 * ⚠️ THERE WAS NO SHELL AT ALL BEFORE THIS. Twelve screens each ended with their
 * own hand-written footer links — `/app/settings/reminders` offered exactly two
 * destinations — so moving around the product meant knowing the URLs. This is
 * the first thing every screen shares.
 *
 * Kept out of the component so the active-section rule can be tested. That rule
 * is the part that goes wrong: the obvious `pathname.startsWith(href)` marks
 * **Home** active on every page in the app, because every path starts with
 * `/app`.
 */

export interface NavItem {
  href: string;
  label: string;
  /** What the destination is FOR, in a customer's words — used as the title. */
  description: string;
}

/**
 * In the order a credit controller works: what am I owed, who owes it, is Eva
 * chasing it, and only then the settings they touch once.
 *
 * ⚠️ NOT DRIVEN BY PERMISSIONS, DELIBERATELY. Every destination already handles
 * its own refusal with a sentence naming what is missing ("your role can see X
 * but not change it"), and hiding a link instead would leave a colleague unable
 * to tell whether a screen is missing or forbidden. Hiding a control is not
 * enforcement — the API refuses regardless (`lib/permissions.ts`).
 */
export const NAV_ITEMS: readonly NavItem[] = [
  { href: "/app", label: "Home", description: "What you are owed and what Eva is doing" },
  { href: "/app/invoices", label: "Invoices", description: "Every invoice on one screen" },
  { href: "/app/clients", label: "Clients", description: "Who owes you" },
  { href: "/app/reminders", label: "Chasing", description: "What Eva has actually sent" },
  {
    href: "/app/settings/reminders",
    label: "Settings",
    description: "When Eva chases, and from where",
  },
];

/**
 * Whether a nav item is the section the user is currently in.
 *
 * ⚠️ `/app` IS AN EXACT MATCH AND EVERYTHING ELSE IS A PREFIX. `startsWith`
 * alone would light up Home on every screen in the product, because every path
 * begins with `/app` — a nav that is always "here" tells you nothing about where
 * you are. A test pins this for every item against every other item's path.
 *
 * The prefix must end at a segment boundary, so `/app/invoices` does not match a
 * hypothetical `/app/invoices-archive`.
 */
export function isActiveSection(pathname: string, href: string): boolean {
  const path = normalise(pathname);
  const target = normalise(href);
  if (target === "/app") return path === "/app";
  return path === target || path.startsWith(`${target}/`);
}

/** Trailing slashes are noise; `/app/invoices/` and `/app/invoices` are one screen. */
function normalise(value: string): string {
  if (value.length > 1 && value.endsWith("/")) return value.slice(0, -1);
  return value;
}

/**
 * Screens that must NOT show the shell.
 *
 * ⚠️ ONBOARDING IS A FLOW, NOT A DESTINATION. Someone who has just signed up has
 * no organisation, so every nav link would land them on "create an organisation
 * first" — a menu of dead ends at the exact moment they need one instruction.
 * `/app/page.tsx` redirects a brand-new account straight here.
 */
const CHROME_FREE_PATHS = ["/app/onboarding", "/app/organisations/new"];

export function showsAppChrome(pathname: string): boolean {
  const path = normalise(pathname);
  return !CHROME_FREE_PATHS.some((free) => path === free || path.startsWith(`${free}/`));
}
