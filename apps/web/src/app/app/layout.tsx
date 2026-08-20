import { ApiError, apiFetch } from "@/lib/api";
import { displayNameFrom, initialsFrom, roleLabel } from "@/lib/identity";
import { createClient } from "@/lib/supabase/server";
import { signOut } from "./actions";
import { AppSidebar } from "./app-sidebar";
import { ChooserHeader } from "./chooser-header";
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
  const { identity, heldModules } = await loadShell();

  return (
    <div className="flex min-h-screen bg-background">
      {/* ⚠️ EXACTLY ONE OF THESE TWO RENDERS ON ANY SIGNED-IN SCREEN, and both
          decide for themselves from the path. The chooser has no sidebar
          (founder, 2026-08-20), so it carries the account menu in a top bar
          instead — and those are the only two homes Settings, Change password
          and Sign out have anywhere in the product. `navigation.spec.ts`
          asserts the exclusivity, because "one or the other" written in a
          comment is how a screen ends up with neither. */}
      <AppSidebar identity={identity} heldModules={heldModules} signOut={signOut} />
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
      <div className="flex min-w-0 flex-1 flex-col">
        <ChooserHeader identity={identity} signOut={signOut} />
        {children}
      </div>
    </div>
  );
}

/**
 * What the shell shows: who you are, and which products you actually hold.
 *
 * ⚠️ `heldModules` IS `null` WHEN WE COULD NOT FIND OUT, AND THAT IS NOT `[]`.
 * Every fetch here swallows its own failure, so a modules call that fails must
 * not be reported as "you own nothing" — the sidebar would then confidently
 * show every product as off. Unknown is its own state and the sidebar renders
 * it as neither.
 */
async function loadShell(): Promise<{
  identity: SidebarIdentity;
  heldModules: readonly string[] | null;
}> {
  const identity = await loadIdentity();
  if (!identity.organisationId) return { identity, heldModules: null };
  try {
    const supabase = await createClient();
    const { data: sessionData } = await supabase.auth.getSession();
    const accessToken = sessionData.session?.access_token;
    if (!accessToken) return { identity, heldModules: null };
    const modules = (await (
      await apiFetch(`/organisations/${identity.organisationId}/modules`, accessToken)
    ).json()) as { moduleKey: string; enabled: boolean }[];
    return {
      identity,
      heldModules: modules.filter((module) => module.enabled).map((module) => module.moduleKey),
    };
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    return { identity, heldModules: null };
  }
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
  if (!accessToken) return { organisationId: null, organisation: null, user };

  try {
    const organisations = (await (await apiFetch("/organisations", accessToken)).json()) as {
      id: string;
      name: string;
      roleKey: string;
    }[];
    // Single-org app today — the same first-of-list rule every screen uses.
    const organisation = organisations[0];
    if (!organisation) return { organisationId: null, organisation: null, user };
    return {
      organisationId: organisation.id,
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
    return { organisationId: null, organisation: null, user };
  }
}
