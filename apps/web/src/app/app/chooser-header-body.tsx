"use client";

import { UserMenu } from "./user-menu";
import type { SidebarIdentity } from "./sidebar-body";

/**
 * Everything the chooser's top bar renders (founder, 2026-08-20).
 *
 * ⚠️ SPLIT FROM `ChooserHeader` FOR THE REASON `SidebarBody` WAS. The wrapper
 * calls `usePathname`, and a hook makes a component unrenderable in a plain
 * node test. This half takes no hooks and no path, so
 * `chooser-header.spec.tsx` can render it with `renderToStaticMarkup` and read
 * what is actually in it.
 *
 * ⚠️ AND IT IS WORTH READING, because on `/app` there is no sidebar: this bar
 * is the ONLY way to Settings, Change password and Sign out. If it renders
 * empty, a customer who lands on the chooser is stuck there with a handful of
 * cards and no way to leave.
 */
export function ChooserHeaderBody({
  identity,
  signOutSlot,
}: {
  identity: SidebarIdentity;
  /** The sign-out form, built by the wrapper — a server action cannot be
   *  constructed in a plain test. */
  signOutSlot: React.ReactNode;
}) {
  return (
    <header className="flex w-full items-center justify-between gap-4 px-10 pt-6">
      {/* The wordmark, matching the sidebar's. A chooser with nothing in the top
          left reads as a page whose header failed to load. */}
      <span className="font-display text-[19px] leading-none font-semibold text-foreground">
        eva<span className="text-accent">.</span>
      </span>

      {/* `identity.user` is never null — the shell always knows who is signed
          in; the organisation is the part that can be missing. */}
      <UserMenu placement="header" user={identity.user} signOutSlot={signOutSlot} />
    </header>
  );
}
