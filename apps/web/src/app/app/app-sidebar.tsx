"use client";

import { usePathname } from "next/navigation";
import { showsSidebar } from "@/lib/navigation";
import { SignOutIcon } from "./nav-icons";
import { SidebarBody, type SidebarIdentity } from "./sidebar-body";
import { ACCOUNT_ITEM_CLASS } from "./user-menu";

/**
 * The signed-in app's sidebar (2026-08-09 design handoff; replaces `AppNav`).
 *
 * ⚠️ A CLIENT COMPONENT ONLY BECAUSE OF `usePathname`, and it fetches NOTHING.
 * A server layout cannot read the current path in Next 16, and the two things
 * the path is needed for both matter: marking the section you are in, and
 * hiding the whole shell during onboarding, where every link would be a dead
 * end. The layout does the fetching and hands the answers down as props.
 *
 * ⚠️ EVERYTHING RENDERABLE LIVES IN `SidebarBody`, which takes the path as an
 * argument. This wrapper is the thin, untestable part on purpose: a hook makes
 * a component unrenderable in a plain node test, and the shell is too central
 * to leave uncovered because of one call.
 *
 * ⚠️ NOT PERMISSION-FILTERED, unchanged from slice 1.9 and still deliberate.
 * Every destination explains its own refusal by name; a hidden link leaves a
 * colleague unable to tell "not allowed" from "not built", and hiding a link
 * was never enforcement — the API refuses regardless.
 */
export function AppSidebar({
  identity,
  heldModules,
  signOut,
}: {
  identity: SidebarIdentity;
  /** Products the organisation holds; `null` when the shell could not find out. */
  heldModules: readonly string[] | null;
  signOut: () => void;
}) {
  const pathname = usePathname() ?? "/app";
  if (!showsSidebar(pathname)) return null;

  return (
    <SidebarBody
      pathname={pathname}
      identity={identity}
      heldModules={heldModules}
      signOutSlot={
        /* ⚠️ A NAMED MENU ITEM NOW, NOT AN ICON (founder, 2026-08-18). It sat
           beside the user's name as a bare glyph whose meaning you had to know
           or hover to find out. Inside the account menu it wears the same row
           as Settings and Change password — `ACCOUNT_ITEM_CLASS` is exported
           for that, so the three cannot drift apart. */
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
