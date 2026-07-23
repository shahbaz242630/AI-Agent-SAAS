import Link from "next/link";
import { OrganisationForm } from "./organisation-form";

export default function NewOrganisationPage() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 p-8">
      <h1 className="text-2xl font-bold text-primary">Create your organisation</h1>
      <OrganisationForm />
      <Link href="/app" className="text-sm font-medium text-muted-foreground hover:underline">
        Back to your organisations
      </Link>
    </main>
  );
}
