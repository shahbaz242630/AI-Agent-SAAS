import Link from "next/link";

/**
 * The five settings screens, as one row of pills (2026-08-09 design handoff).
 *
 * ⚠️ THE SIDEBAR HAS ONE "SETTINGS" LINK AND THERE ARE FIVE SCREENS BEHIND IT.
 * Before this, the only way to reach Mailbox or Modules was to already know the
 * URL — the same maze the app shell was built to end, surviving one level down.
 *
 * ⚠️ IT SAID "FOUR" IN BOTH PLACES UNTIL 2026-08-30, NINE DAYS AFTER DO NOT
 * CONTACT BECAME THE FIFTH. The note that added the fifth tab is thirty lines
 * below and was written by somebody who never scrolled back up. Copy has no
 * assertions unless somebody writes them — `settings-consistency.spec.tsx` now
 * counts the tabs and reads this sentence, so the next tab cannot land without
 * fixing it.
 *
 * ⚠️ NOT PERMISSION-FILTERED, the same rule as the sidebar. Every destination
 * explains its own refusal by name, and hiding a tab leaves a colleague unable
 * to tell "not allowed" from "not built". Hiding was never enforcement.
 *
 * `current` is passed rather than read from `usePathname` so this stays a
 * server component and can be rendered in a plain test.
 */
/**
 * ⚠️ TWO LABELS RENAMED 2026-08-11, AND THE ROUTES DELIBERATELY LEFT ALONE.
 *
 * "Invoices" → **Currency**: the screen behind it contains one setting, the
 * currency a new invoice opens on. A tab promising invoice settings and
 * delivering a single dropdown makes a customer wonder what they have missed.
 *
 * "Modules" → **Products**: `module` is the database's word — the table is
 * `organisation_modules` — and the page behind this tab has been headed "Your
 * products" since it was built. The customer-facing name was already decided;
 * only the tab still said otherwise.
 *
 * The `key` and `href` stay as they are: they are internal, no customer reads
 * them, and renaming routes would break every link and bookmark to buy nothing.
 */
/**
 * ⚠️ "DO NOT CONTACT" IS A FIFTH TAB AND NOT A LEAD SCREEN (2026-08-21).
 * Suppression is organisation-wide and crosses every product: an entry recorded
 * on an enquiry also stops invoice chasers to the same address. Reaching it
 * only from the lead it came from would be a correction nobody could find — and
 * the entry might not have come from a lead at all.
 */
export const SETTINGS_TABS = [
  { key: "reminders", href: "/app/settings/reminders", label: "Reminders" },
  { key: "mailbox", href: "/app/settings/mailbox", label: "Mailbox" },
  { key: "invoices", href: "/app/settings/invoices", label: "Currency" },
  { key: "modules", href: "/app/settings/modules", label: "Products" },
  { key: "do-not-contact", href: "/app/settings/do-not-contact", label: "Do not contact" },
] as const;

export type SettingsTabKey = (typeof SETTINGS_TABS)[number]["key"];

export function SettingsTabs({ current }: { current: SettingsTabKey }) {
  return (
    <nav aria-label="Settings sections" className="flex flex-wrap items-center gap-2">
      {SETTINGS_TABS.map((tab) => {
        const active = tab.key === current;
        return (
          <Link
            key={tab.key}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={`rounded-[var(--radius-pill)] px-3.5 py-1.5 text-xs font-semibold ${
              active
                ? "bg-primary text-primary-foreground"
                : "border border-input-border bg-surface hover:bg-chip-hover"
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
