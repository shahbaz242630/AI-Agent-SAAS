import Link from "next/link";
import { redirect } from "next/navigation";
import { ApiError, apiFetch } from "@/lib/api";
import { createClient } from "@/lib/supabase/server";
import { signOut } from "./actions";

// Response shapes mirror the API contracts (apps/api users/organisations).
interface AppUser {
  id: string;
  email: string;
  fullName: string | null;
}

interface OrganisationSummary {
  id: string;
  name: string;
  roleKey: string;
}

export default async function AppHomePage() {
  const supabase = await createClient();

  // Verify identity from the JWT claims (proxy also guards this route), then
  // take the raw access token to forward to the Eva API.
  const { data: claimsData } = await supabase.auth.getClaims();
  if (!claimsData?.claims) {
    redirect("/sign-in");
  }
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) {
    redirect("/sign-in");
  }

  let me: AppUser;
  let organisations: OrganisationSummary[];
  try {
    const [meResponse, organisationsResponse] = await Promise.all([
      apiFetch("/users/me", accessToken),
      apiFetch("/organisations", accessToken),
    ]);
    me = (await meResponse.json()) as AppUser;
    organisations = (await organisationsResponse.json()) as OrganisationSummary[];
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      redirect("/sign-in");
    }
    return (
      <main className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
        <h1 className="text-2xl font-bold text-primary">Something went wrong</h1>
        <p className="max-w-md text-muted-foreground">
          {error instanceof ApiError
            ? error.message
            : "We couldn't load your account. Please try again in a moment."}
        </p>
        <form action={signOut}>
          <button type="submit" className="text-sm font-medium text-primary hover:underline">
            Sign out
          </button>
        </form>
      </main>
    );
  }

  // A brand-new account has nothing to look at here, so send it straight into
  // setup — that is the founder's journey: sign up, name the business, connect
  // the mailbox, move on. Only when there is NO organisation at all. Once one
  // exists this page has something real to show, and dragging someone back into
  // a flow they chose to leave would be a trap rather than a guide.
  if (organisations.length === 0) {
    redirect("/app/onboarding");
  }

  // Whether setup is actually finished. Best-effort: not every role can read
  // mailbox status, and a nudge is not worth failing the home page over.
  let mailboxConnected: boolean | null = null;
  try {
    const response = await apiFetch(
      `/organisations/${organisations[0]!.id}/mailboxes`,
      accessToken,
    );
    const body = (await response.json()) as { mailboxes: unknown[] };
    mailboxConnected = body.mailboxes.length > 0;
  } catch {
    // Also swallows the 402 of an organisation that has not got Invoice
    // Chasing — it has no mailbox to finish setting up, so the nudge below
    // would be wrong rather than merely missing.
    mailboxConnected = null;
  }

  return (
    <main className="flex flex-1 flex-col items-center gap-8 p-8">
      <header className="flex w-full max-w-2xl items-center justify-between">
        <span className="text-xl font-bold text-primary">Eva</span>
        <form action={signOut}>
          <button
            type="submit"
            className="rounded-[var(--radius-card)] bg-muted px-4 py-2 text-sm font-medium hover:opacity-80"
          >
            Sign out
          </button>
        </form>
      </header>

      <section className="flex w-full max-w-2xl flex-col gap-2">
        <h1 className="text-2xl font-bold">Welcome{me.fullName ? `, ${me.fullName}` : ""}</h1>
        <p className="text-muted-foreground">Signed in as {me.email}</p>
      </section>

      {mailboxConnected === false && (
        <section className="flex w-full max-w-2xl flex-col gap-3 rounded-[var(--radius-card)] bg-muted px-6 py-4">
          <div className="flex flex-col gap-1">
            <h2 className="text-base font-semibold">Finish setting up</h2>
            <p className="text-sm text-muted-foreground">
              Eva can&apos;t chase anything until it can send from your mailbox.
            </p>
          </div>
          <div>
            <Link
              href="/app/onboarding"
              className="rounded-[var(--radius-card)] bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
            >
              Connect your mailbox
            </Link>
          </div>
        </section>
      )}

      <section className="flex w-full max-w-2xl flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Your organisations</h2>
          <div className="flex gap-2">
            <Link
              href="/app/organisations/new"
              className="rounded-[var(--radius-card)] bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
            >
              New organisation
            </Link>
            <Link
              href="/app/settings/mailbox"
              className="rounded-[var(--radius-card)] bg-muted px-4 py-2 text-sm font-medium hover:opacity-80"
            >
              Mailbox settings
            </Link>
          </div>
        </div>
        {/* No empty state: an account with no organisation was redirected into
            setup above and never reaches this list. */}
        <ul className="flex flex-col gap-2">
          {organisations.map((organisation) => (
            <li
              key={organisation.id}
              className="flex items-center justify-between rounded-[var(--radius-card)] bg-muted px-6 py-4 text-sm"
            >
              <span className="font-medium">{organisation.name}</span>
              <span className="text-muted-foreground">{organisation.roleKey}</span>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
