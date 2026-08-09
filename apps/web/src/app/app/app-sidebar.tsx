"use client";

import { usePathname } from "next/navigation";
import { showsAppChrome } from "@/lib/navigation";
import { SignOutIcon } from "./nav-icons";
import { SidebarBody, type SidebarIdentity } from "./sidebar-body";

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
  signOut,
}: {
  identity: SidebarIdentity;
  signOut: () => void;
}) {
  const pathname = usePathname() ?? "/app";
  if (!showsAppChrome(pathname)) return null;

  return (
    <SidebarBody
      pathname={pathname}
      identity={identity}
      signOutSlot={
        <form action={signOut} className="flex">
          <button
            type="submit"
            title="Sign out"
            className="flex cursor-pointer rounded-md p-1 hover:bg-sidebar-active"
          >
            <SignOutIcon />
            <span className="sr-only">Sign out</span>
          </button>
        </form>
      }
    />
  );
}
