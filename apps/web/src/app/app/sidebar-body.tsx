import Link from "next/link";
import { NAV_ITEMS, isActiveSection } from "@/lib/navigation";
import { NAV_ICONS } from "./nav-icons";

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
  /** `null` when the fetch failed or the account has no organisation yet. */
  organisation: { name: string; initials: string; roleLabel: string } | null;
  user: { name: string; email: string; initials: string };
}

/** The modules, live first. The `soon` ones are named so the shape is honest. */
const MODULES: readonly { label: string; live: boolean }[] = [
  { label: "Invoice Chasing", live: true },
  { label: "Lead Follow-up", live: false },
  { label: "AI Reception", live: false },
];

export function SidebarBody({
  pathname,
  identity,
  signOutSlot,
}: {
  pathname: string;
  identity: SidebarIdentity;
  /**
   * The sign-out control, passed in rather than built here. It is a form bound
   * to a server action, and a server action cannot be constructed inside a
   * plain test — so the one piece that cannot be rendered offline is the one
   * piece this component does not own.
   */
  signOutSlot: React.ReactNode;
}) {
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

      <ul className="mt-5 flex flex-col gap-0.5">
        {NAV_ITEMS.map((item) => {
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
        <h2 className="px-2.5 text-[10.5px] font-bold tracking-[0.08em] text-sidebar-fainter uppercase">
          Modules
        </h2>
        <ul className="flex flex-col gap-2">
          {MODULES.map((module) => (
            <li
              key={module.label}
              className={`flex items-center gap-2 px-2.5 py-[3px] text-[12.5px] ${
                module.live ? "text-sidebar-body" : "justify-between text-sidebar-fainter"
              }`}
            >
              {module.live ? (
                <>
                  <span aria-hidden className="size-[7px] rounded-full bg-module-live" />
                  {module.label}
                </>
              ) : (
                <>
                  {module.label}
                  {/* "soon" rather than a hidden row: naming what is coming is
                      honest, and a customer who wants it can ask for it. */}
                  <span className="rounded-[var(--radius-pill)] border border-sidebar-chip-border px-[7px] py-px text-[10px] font-semibold">
                    soon
                  </span>
                </>
              )}
            </li>
          ))}
        </ul>
      </div>

      <div className="flex-1" />

      <div className="flex items-center gap-2.5 rounded-[var(--radius-control)] bg-sidebar-hover p-2">
        <span
          aria-hidden
          className="flex size-7 shrink-0 items-center justify-center rounded-full bg-sidebar-avatar text-[11px] font-semibold text-sidebar-foreground"
        >
          {identity.user.initials}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-xs font-semibold text-sidebar-foreground">
            {identity.user.name}
          </span>
          <span className="truncate text-[10.5px] text-sidebar-faint">{identity.user.email}</span>
        </span>
        {signOutSlot}
      </div>
    </nav>
  );
}
