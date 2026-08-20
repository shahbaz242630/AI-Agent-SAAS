"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { ACCOUNT_MENU_ITEMS } from "@/lib/navigation";
import { ChevronIcon, PasswordIcon, SettingsIcon } from "./nav-icons";

/**
 * The account menu at the foot of the sidebar (founder, 2026-08-18).
 *
 * ⚠️ IT OPENS UPWARDS, AND THAT IS NOT A STYLE CHOICE. This card is pinned to
 * the bottom of a full-height sidebar; a menu dropping DOWN would open past the
 * bottom of the window every time. `bottom-full` puts it above the trigger,
 * where the space actually is.
 *
 * ⚠️ THE ITEMS STAY IN THE MARKUP WHEN SHUT, hidden with a class rather than
 * removed. `SidebarBody` is rendered by `renderToStaticMarkup` in a plain node
 * test — no DOM, no clicks — so a menu that only exists once opened would be a
 * menu no test could ever see. `hidden` keeps it out of the accessibility tree
 * and off the screen while leaving it where a test can read it.
 *
 * ⚠️ THIS IS THE ONLY WAY INTO `/change-password` AND, SINCE TODAY, INTO
 * SETTINGS. Both used to be reachable another way — Settings as a nav section,
 * the password as an unlabelled padlock. If this menu ever stops rendering,
 * two screens leave the product without a single test failing on the routes
 * themselves.
 */

/* Typed with the props `SettingsIcon` takes; `PasswordIcon` takes none, and a
   function of fewer parameters is assignable to one of more. */
const ICONS: Readonly<
  Record<string, (props: { className?: string | undefined }) => React.JSX.Element>
> = {
  "/app/settings/reminders": SettingsIcon,
  "/change-password": PasswordIcon,
};

/**
 * One row of the menu.
 *
 * ⚠️ EXPORTED SO SIGN-OUT CAN WEAR IT TOO. That control is built in
 * `AppSidebar` — it has to be, it wraps a server action — and a menu whose last
 * item is a different size and weight from the two above it looks like a
 * mistake rather than a menu.
 */
export const ACCOUNT_ITEM_CLASS =
  "flex w-full cursor-pointer items-center gap-2.5 rounded-[9px] px-2.5 py-2 text-[13px] font-medium text-sidebar-body hover:bg-sidebar-hover";

/**
 * Where this menu is mounted, which decides which way it opens and which half
 * of the palette it wears.
 *
 * ⚠️ ONE PROP, TWO COHERENT PRESETS — not a pile of style overrides. The two
 * placements differ in three ways at once (direction, alignment, palette), and
 * any mix of them that is not one of these two is wrong: a dark panel on the
 * light header is unreadable, and a downward menu at the foot of a full-height
 * sidebar opens past the bottom of the window.
 *
 * `sidebar` is the original: pinned to the bottom of the dark sidebar, opening
 * upwards where the space actually is. `header` is the chooser's top bar
 * (founder, 2026-08-20) — light surface, opening downwards, right-aligned to
 * the trigger because the trigger sits at the right-hand end of the bar.
 */
export type UserMenuPlacement = "sidebar" | "header";

/** The dropdown panel itself. */
const PANEL_CLASS: Record<UserMenuPlacement, string> = {
  sidebar:
    "absolute bottom-full left-0 mb-2 flex w-full flex-col gap-0.5 rounded-[var(--radius-control)] border border-sidebar-border bg-sidebar-panel p-1.5 shadow-[var(--shadow-panel)]",
  header:
    "absolute top-full right-0 z-20 mt-2 flex w-56 flex-col gap-0.5 rounded-[var(--radius-control)] border border-sidebar-border bg-sidebar-panel p-1.5 shadow-[var(--shadow-panel)]",
};

/**
 * The trigger.
 *
 * ⚠️ THE PANEL STAYS DARK IN BOTH PLACEMENTS, AND ONLY THE TRIGGER CHANGES.
 * Every row inside it wears `ACCOUNT_ITEM_CLASS`, whose colours are the
 * sidebar's — restyling the panel for the light header would mean a second set
 * of item classes, and `ACCOUNT_ITEM_CLASS` exists precisely because three
 * items drifting apart looked like a mistake. A dark menu panel on a light bar
 * is an ordinary pattern; three differently-coloured menus are not.
 */
const TRIGGER_CLASS: Record<UserMenuPlacement, string> = {
  sidebar:
    "flex w-full cursor-pointer items-center gap-2.5 rounded-[var(--radius-control)] bg-sidebar-hover p-2 text-left hover:bg-sidebar-active",
  header:
    "flex cursor-pointer items-center gap-2.5 rounded-[var(--radius-control)] border border-border bg-surface p-1.5 pr-2.5 text-left hover:bg-row-hover",
};

/** Name and email inside the trigger — dark sidebar versus light bar. */
const TRIGGER_NAME_CLASS: Record<UserMenuPlacement, string> = {
  sidebar: "truncate text-xs font-semibold text-sidebar-foreground",
  header: "truncate text-xs font-semibold text-foreground",
};

const TRIGGER_EMAIL_CLASS: Record<UserMenuPlacement, string> = {
  sidebar: "truncate text-[10.5px] text-sidebar-faint",
  header: "truncate text-[10.5px] text-muted-foreground",
};

const CHEVRON_CLASS: Record<UserMenuPlacement, string> = {
  sidebar: "shrink-0 text-sidebar-faint",
  header: "shrink-0 text-muted-foreground",
};

export function UserMenu({
  user,
  signOutSlot,
  placement = "sidebar",
}: {
  user: { name: string; email: string; initials: string };
  /**
   * Sign out, passed in for the same reason `SidebarBody` takes it: it is a
   * form bound to a server action, and a server action cannot be constructed
   * in a plain test.
   */
  signOutSlot: React.ReactNode;
  /** Defaults to the sidebar, so the twelve screens that already use it are
   *  untouched by the chooser's arrival. */
  placement?: UserMenuPlacement;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && rootRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      // Escape hands the keyboard back, or the next Tab restarts at the top of
      // the document — from a control at the very bottom of the page.
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <div
        id={menuId}
        role="menu"
        aria-label="Account"
        /* `hidden` and not an early return — see the note above the component. */
        className={open ? PANEL_CLASS[placement] : "hidden"}
      >
        {ACCOUNT_MENU_ITEMS.map((item) => {
          const Icon = ICONS[item.href];
          return (
            <Link
              key={item.href}
              href={item.href}
              role="menuitem"
              title={item.description}
              onClick={() => setOpen(false)}
              className={ACCOUNT_ITEM_CLASS}
            >
              {Icon && <Icon />}
              {item.label}
            </Link>
          );
        })}
        {/* ⚠️ SEPARATED, BECAUSE IT IS THE ONE THAT ENDS THE SESSION. The design
            package sets sign-out in red, but that is specified against the
            LIGHT marketing header; the same #b91c1c on this charcoal panel is
            barely legible. A divider carries the same "this one is different"
            without inventing a colour the palette does not have. */}
        <div className="my-1 h-px bg-sidebar-border" />
        {signOutSlot}
      </div>

      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(!open)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        className={TRIGGER_CLASS[placement]}
      >
        <span
          aria-hidden
          className="flex size-7 shrink-0 items-center justify-center rounded-full bg-sidebar-avatar text-[11px] font-semibold text-sidebar-foreground"
        >
          {user.initials}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className={TRIGGER_NAME_CLASS[placement]}>{user.name}</span>
          <span className={TRIGGER_EMAIL_CLASS[placement]}>{user.email}</span>
        </span>
        <ChevronIcon className={`${CHEVRON_CLASS[placement]} ${open ? "rotate-180" : ""}`} />
      </button>
    </div>
  );
}
