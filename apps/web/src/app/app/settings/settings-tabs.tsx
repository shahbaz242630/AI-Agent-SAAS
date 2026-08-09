import Link from "next/link";

/**
 * The four settings screens, as one row of pills (2026-08-09 design handoff).
 *
 * ⚠️ THE SIDEBAR HAS ONE "SETTINGS" LINK AND THERE ARE FOUR SCREENS BEHIND IT.
 * Before this, the only way to reach Mailbox or Modules was to already know the
 * URL — the same maze the app shell was built to end, surviving one level down.
 *
 * ⚠️ NOT PERMISSION-FILTERED, the same rule as the sidebar. Every destination
 * explains its own refusal by name, and hiding a tab leaves a colleague unable
 * to tell "not allowed" from "not built". Hiding was never enforcement.
 *
 * `current` is passed rather than read from `usePathname` so this stays a
 * server component and can be rendered in a plain test.
 */
export const SETTINGS_TABS = [
  { key: "reminders", href: "/app/settings/reminders", label: "Reminders" },
  { key: "mailbox", href: "/app/settings/mailbox", label: "Mailbox" },
  { key: "invoices", href: "/app/settings/invoices", label: "Invoices" },
  { key: "modules", href: "/app/settings/modules", label: "Modules" },
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
