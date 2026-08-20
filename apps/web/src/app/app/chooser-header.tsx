"use client";

import { usePathname } from "next/navigation";
import { showsChooserHeader } from "@/lib/navigation";
import { ChooserHeaderBody } from "./chooser-header-body";
import { SignOutIcon } from "./nav-icons";
import { ACCOUNT_ITEM_CLASS } from "./user-menu";
import type { SidebarIdentity } from "./sidebar-body";

/**
 * The chooser's top bar (founder, 2026-08-20).
 *
 * ⚠️ THE CHOOSER HAS NO SIDEBAR, SO THE ACCOUNT MENU HAS TO LIVE SOMEWHERE.
 * Founder: *"this page is like a page which drives traffic to product… we don't
 * need to have a side bar… our footer block which carries setting, change
 * password, sign out will be moved to top right same as drop down… so this page
 * only has cards to choose which feature"*.
 *
 * ⚠️ IT IS NOT DECORATION — IT IS THE ONLY WAY OFF THIS SCREEN. Settings,
 * change password and sign out are reachable from nowhere else on `/app` once
 * the sidebar is gone (`user-menu.tsx` already says it is the only route to two
 * of them). If this stops rendering, somebody landing here is stuck with a
 * handful of cards. `navigation.spec.ts` asserts that exactly one of the
 * sidebar and this bar shows on every signed-in path, which is what keeps that
 * true — a comment saying "one or the other" is how a screen ends up with
 * neither.
 *
 * ⚠️ A CLIENT COMPONENT ONLY BECAUSE OF `usePathname`, exactly like
 * `AppSidebar`, and it fetches nothing. The layout does the fetching and hands
 * the answers down.
 */
export function ChooserHeader({
  identity,
  signOut,
}: {
  identity: SidebarIdentity;
  signOut: () => void;
}) {
  const pathname = usePathname() ?? "/app";
  if (!showsChooserHeader(pathname)) return null;

  return (
    <ChooserHeaderBody
      identity={identity}
      signOutSlot={
        /* Built here rather than in the body for the same reason `AppSidebar`
           builds its own: it is a form bound to a server action, and a server
           action cannot be constructed in a plain node test. Same
           `ACCOUNT_ITEM_CLASS` as the two links above it, so the three rows
           cannot drift apart. */
        <form action={signOut} className="flex">
          <button type="submit" role="menuitem" className={ACCOUNT_ITEM_CLASS}>
            <SignOutIcon />
            Sign out
          </button>
        </form>
      }
    />
  );
}
