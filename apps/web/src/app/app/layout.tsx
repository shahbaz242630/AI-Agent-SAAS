import { ApiError, apiFetch } from "@/lib/api";
import { displayNameFrom, initialsFrom, roleLabel } from "@/lib/identity";
import { createClient } from "@/lib/supabase/server";
import { signOut } from "./actions";
import { AppSidebar } from "./app-sidebar";
import type { SidebarIdentity } from "./sidebar-body";

/**
 * The shell every signed-in screen shares (2026-08-09 design handoff).
 *
 * ⚠️ THIS LAYER NOW FETCHES, AND SLICE 1.9 DELIBERATELY DID NOT. That decision
 * is being reversed on purpose, not forgotten: the old top nav showed nothing
 * but links, and the sidebar shows which organisation you are in and which
 * account you are signed in as. Both are the answers to "am I in the right
 * place", which is the question a shell exists to answer.
 *
 * ⚠️ IT STILL DOES NOT GUARD THE ROUTE. Each page verifies its own session and
 * redirects; the proxy guards the route. A failure here must never be a
 * redirect, because a layout that redirects on a hiccup would throw somebody
 * out of a screen that was working.
 *
 * ⚠️ EVERY FETCH SWALLOWS ITS OWN FAILURE — the dashboard's rule, and it
 * matters more here. A shell that 500s takes every screen with it, so the
 * organisation chip is simply absent when we could not read it, and the app
 * still works. A brand-new account genuinely HAS no organisation, so absent is
 * a real state rather than only an error one.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const identity = await loadIdentity();

  return (
    <div className="flex min-h-screen bg-background">
      <AppSidebar identity={identity} signOut={signOut} />
      {/*
       * ⚠️ A `div`, NOT A `main`, AND THAT IS NOT A DETAIL. All twelve signed-in
       * screens render their own `<main>`; wrapping them in another one would
       * nest a landmark inside itself, which is invalid HTML and leaves a screen
       * reader with two "main" regions to choose between. The per-screen column
       * moves in here when those screens are redesigned — until then this layer
       * owns the sidebar and nothing else.
       *
       * ⚠️ `min-w-0` IS LOAD-BEARING. A flex child defaults to `min-width:auto`,
       * so the invoice table's own minimum width would push this column wider
       * than the viewport and put a horizontal scrollbar on the PAGE instead of
       * inside the table's card.
       */}
      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
    </div>
  );
}

async function loadIdentity(): Promise<SidebarIdentity> {
  const supabase = await createClient();
  const { data: claimsData } = await supabase.auth.getClaims();
  const email = typeof claimsData?.claims.email === "string" ? claimsData.claims.email : "";

  const user = {
    name: displayNameFrom(email),
    email,
    initials: initialsFrom(email),
  };

  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) return { organisation: null, user };

  try {
    const organisations = (await (await apiFetch("/organisations", accessToken)).json()) as {
      name: string;
      roleKey: string;
    }[];
    // Single-org app today — the same first-of-list rule every screen uses.
    const organisation = organisations[0];
    if (!organisation) return { organisation: null, user };
    return {
      organisation: {
        name: organisation.name,
        initials: initialsFrom(organisation.name),
        roleLabel: roleLabel(organisation.roleKey),
      },
      user,
    };
  } catch (error) {
    // 401 included: the page below will do the redirecting, and doing it here
    // as well would race it.
    if (!(error instanceof ApiError)) throw error;
    return { organisation: null, user };
  }
}
