"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV_ITEMS, isActiveSection, showsAppChrome } from "@/lib/navigation";

/**
 * The signed-in app's navigation (Slice 1.9).
 *
 * ⚠️ A CLIENT COMPONENT ONLY BECAUSE OF `usePathname`. A server layout cannot
 * read the current path in Next 16, and the two things this needs it for are
 * both worth having: marking the section you are in, and hiding itself during
 * onboarding, where every link would be a dead end.
 *
 * It fetches nothing. The alternative — reading permissions here to hide links —
 * was rejected: every destination already explains its own refusal by name, and
 * a hidden link leaves a colleague unable to tell "not allowed" from "not
 * built". See `lib/navigation.ts`.
 */
export function AppNav() {
  const pathname = usePathname() ?? "/app";
  if (!showsAppChrome(pathname)) return null;

  return (
    <nav aria-label="Sections" className="w-full border-b border-muted-foreground/15 bg-background">
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-1 px-4 py-2">
        <Link href="/app" className="mr-3 text-lg font-bold text-primary">
          Eva
        </Link>
        {NAV_ITEMS.map((item) => {
          const active = isActiveSection(pathname, item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              title={item.description}
              /* The current section is named for a screen reader too — colour
                 alone is not an answer to "where am I". */
              aria-current={active ? "page" : undefined}
              className={
                active
                  ? "rounded-[var(--radius-card)] bg-muted px-3 py-1.5 text-sm font-semibold text-primary"
                  : "rounded-[var(--radius-card)] px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-muted"
              }
            >
              {item.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
