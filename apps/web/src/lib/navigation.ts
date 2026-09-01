import { MODULE_KEYS, moduleHref, type ModuleKey } from "@eva/types";

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
  { href: "/app", label: "All products", description: "Everything Eva does for you" },
  { href: "/app/clients", label: "Clients", description: "Who owes you" },
];

/**
 * The sections INSIDE a product, keyed by the product that owns them.
 *
 * ⚠️ THIS IS THE NAV HALF OF THE PLATFORM/PRODUCT SPLIT. `NAV_ITEMS` above is
 * the platform: the hub, and Clients — which stays outside every product
 * because there is **one client record** (BRD §3.1.3), and a customer who holds
 * only a lead product must still reach their own contacts.
 *
 * ⚠️ HREFS ARE BUILT WITH `moduleHref`, NEVER WRITTEN OUT. The product's path
 * segment lives in `MODULE_CATALOGUE.slug` and nowhere else; a literal
 * "/app/invoice-chasing" here would be a second copy that goes stale silently
 * the day a product is renamed.
 */
export const PRODUCT_NAV: Partial<Record<ModuleKey, readonly NavItem[]>> = {
  email_credit_controller: [
    {
      href: moduleHref("email_credit_controller"),
      label: "Home",
      description: "What you are owed and what Eva is doing",
    },
    {
      href: moduleHref("email_credit_controller", "invoices"),
      label: "Invoices",
      description: "Every invoice on one screen",
    },
    {
      href: moduleHref("email_credit_controller", "chasing"),
      label: "Chasing",
      description: "What Eva has actually sent",
    },
    /**
     * ⚠️ EACH PRODUCT CARRIES ITS OWN MAILBOX ENTRY (slice 3.1c-0). It was one
     * tab under Settings until 2026-09-01, when the founder ruled the two
     * products get *"full complete seperate setups.. nothing combined/shared"*.
     * A mailbox belongs to one product, so there is no organisation-wide
     * mailbox screen left to link to.
     */
    {
      href: moduleHref("email_credit_controller", "mailbox"),
      label: "Mailbox",
      description: "The address Eva chases from",
    },
  ],
  /**
   * Slice 3.1a, and TWO sections since 3.1c-0 — Mailbox joined Enquiries when
   * mailbox setup moved inside each product (founder ruling 2026-09-01).
   *
   * Still no "Home" entry: the product's root only redirects to Enquiries until
   * 3.1c gives it a dashboard worth the click, and a nav item pointing at a
   * redirect is a menu entry that lies about where it goes.
   */
  lead_follow_up_email: [
    {
      href: moduleHref("lead_follow_up_email", "enquiries"),
      label: "Enquiries",
      description: "Everyone who has got in touch",
    },
    {
      href: moduleHref("lead_follow_up_email", "mailbox"),
      label: "Mailbox",
      description: "The address Eva replies from",
    },
  ],
};

/**
 * Which product's screens the current path belongs to, or null on a platform
 * screen. Drives which sections the sidebar shows.
 */
export function productForPath(pathname: string): ModuleKey | null {
  const path = normalise(pathname);
  for (const key of MODULE_KEYS) {
    const base = moduleHref(key);
    if (path === base || path.startsWith(`${base}/`)) return key;
  }
  return null;
}

/**
 * The account menu at the foot of the sidebar (founder, 2026-08-18).
 *
 * ⚠️ SETTINGS MOVED HERE OUT OF `NAV_ITEMS`, and the split is by WHO the screen
 * is about. Home, Invoices, Clients and Chasing are the business — the things
 * somebody came to Eva to look at. Settings, your password and signing out are
 * about the person using it, and they now sit together under that person's own
 * name instead of one being a section and the other two being unlabelled icons.
 *
 * ⚠️ `/change-password` IS OUTSIDE `/app` ON PURPOSE and is why this is a
 * separate list rather than a flag on `NavItem`: every entry in `NAV_ITEMS` is
 * a section of the app, and a test asserts each one starts with `/app`.
 */
export const ACCOUNT_MENU_ITEMS: readonly NavItem[] = [
  {
    href: "/app/settings/reminders",
    label: "Settings",
    description: "When Eva chases, and from where",
  },
  {
    href: "/change-password",
    label: "Change password",
    description: "Set a new password without signing out",
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
  /**
   * ⚠️ A PRODUCT'S HOME NEEDS THE SAME EXACT-MATCH RULE AS `/app`, AND THIS WAS
   * A LIVE BUG FOR ABOUT A MINUTE (2026-08-19).
   *
   * `/app` was special-cased because every path begins with it. The moment
   * products got their own routes, each product's home became a prefix of all
   * of that product's sections too — so on `/app/invoice-chasing/chasing` the
   * nav lit **Home**, which is the original defect reappearing one level down.
   * Caught by the test written for the first version of it.
   */
  if (target === "/app" || isProductRoot(target)) return path === target;
  return path === target || path.startsWith(`${target}/`);
}

/** Whether a path is a product's own root — `/app/invoice-chasing`, not one of
 *  its sections. Derived from the catalogue, never a hand-written list. */
function isProductRoot(path: string): boolean {
  return MODULE_KEYS.some((key) => moduleHref(key) === path);
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

/**
 * The chooser — `/app` itself.
 *
 * ⚠️ IT IS A DIFFERENT KIND OF SCREEN FROM EVERY OTHER SIGNED-IN ONE, and
 * founder ruling 2026-08-20 makes that explicit: *"this page is like a page
 * which drives traffic to product… we don't need to have a side bar… so this
 * page only has cards to choose which feature"*. A workspace needs navigation
 * down the side; a chooser needs nothing competing with the choice.
 */
export function isChooserPath(pathname: string): boolean {
  return normalise(pathname) === "/app";
}

/**
 * The sidebar: every signed-in screen EXCEPT the chooser and the onboarding
 * flow. Two different reasons, deliberately kept in one predicate — the sidebar
 * asks one question ("do I render?") and should not have to know why not.
 */
export function showsSidebar(pathname: string): boolean {
  return showsAppChrome(pathname) && !isChooserPath(pathname);
}

/**
 * The chooser's own top bar, which carries the account menu the sidebar would
 * otherwise have carried.
 *
 * ⚠️ THE TWO ARE EXCLUSIVE AND EXHAUSTIVE ON PURPOSE. Settings, change password
 * and sign out live in exactly one of these on any given screen. If both could
 * be false on a screen that shows the shell, those three would be unreachable —
 * `user-menu.tsx` already warns that it is the ONLY way into two of them, and a
 * test below asserts the property rather than trusting the reading.
 */
export function showsChooserHeader(pathname: string): boolean {
  return showsAppChrome(pathname) && isChooserPath(pathname);
}
