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

      <section className="flex w-full max-w-2xl flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Your organisations</h2>
          <Link
            href="/app/organisations/new"
            className="rounded-[var(--radius-card)] bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
          >
            New organisation
          </Link>
        </div>
        {organisations.length === 0 ? (
          <p className="rounded-[var(--radius-card)] bg-muted px-6 py-4 text-sm text-muted-foreground">
            You don&apos;t belong to an organisation yet. Create one to get started.
          </p>
        ) : (
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
        )}
      </section>
    </main>
  );
}
