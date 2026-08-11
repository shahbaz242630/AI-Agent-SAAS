import Link from "next/link";
import { OrganisationForm } from "./organisation-form";

export default function NewOrganisationPage() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 p-8">
      <h1 className="text-2xl font-bold text-primary">Create your organisation</h1>
      <OrganisationForm />
      {/* ⚠️ THIS LINK STAYS, UNLIKE THE OTHERS REMOVED ON 2026-08-11, because
          this route is chrome-free (`CHROME_FREE_PATHS`) — there is no sidebar
          here, so taking it away would leave somebody with no way out at all.
          Only the label was wrong: `/app` has been Home since slice 1.9, not a
          list of organisations. */}
      <Link href="/app" className="text-sm font-medium text-muted-foreground hover:underline">
        Back to Eva
      </Link>
    </main>
  );
}
