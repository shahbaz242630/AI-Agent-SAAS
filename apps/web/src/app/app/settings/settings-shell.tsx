import Link from "next/link";
import { PageHeader, PageShell } from "@/components/ui";
import { SettingsTabs, type SettingsTabKey } from "./settings-tabs";

/**
 * The frame all five settings screens share (founder ruling 2026-08-30, after
 * the five were read side by side for the first time).
 *
 * ⚠️ THE WIDTH IS HERE BECAUSE IT CANNOT BE TRUSTED TO FIVE FILES. Before this,
 * Currency, Reminders, Mailbox and Products constrained their content to
 * `max-w-2xl`, Do not contact used `max-w-3xl`, and Reminders used BOTH — a
 * 2xl heading above a 3xl schedule, on one screen, so the page changed width
 * halfway down itself. Every one of those was a hand-typed class on a hand-typed
 * `<section>`, which is a decision nobody was making on purpose.
 *
 * Now the column is the frame's, once. A page cannot pick its own width because
 * it is never asked, and the tab row sits inside the same column instead of
 * overhanging the content by 400px on every settings screen.
 *
 * ⚠️ THE HEADER AND TABS RENDER EVEN WITH NO ORGANISATION. Three of the five
 * used to drop both and print one orphan sentence on an otherwise empty page,
 * which loses you the tabs at exactly the moment you are lost. Mailbox and
 * Products already did it this way; this is that behaviour, everywhere.
 */
export function SettingsShell({
  title,
  subtitle,
  current,
  children,
}: {
  title: string;
  subtitle: string;
  current: SettingsTabKey;
  children: React.ReactNode;
}) {
  return (
    <PageShell>
      <div className="flex w-full max-w-2xl flex-col gap-[26px]">
        <PageHeader title={title} subtitle={subtitle} />
        <SettingsTabs current={current} />
        {children}
      </div>
    </PageShell>
  );
}

/**
 * No organisation yet — and the way to make one.
 *
 * ⚠️ THREE OF THE FIVE SETTINGS SCREENS USED TO DEAD-END HERE. Currency,
 * Reminders and Do not contact each said "Create an organisation first." and
 * stopped, offering nothing to press; Mailbox and Products said the same
 * sentence and linked to the form that fixes it. Same words, three screens
 * where you were stuck — the difference was invisible to anyone reading one
 * file at a time, which is how it survived seven sessions.
 *
 * ⚠️ `{" "}` BEFORE THE LINK IS LOAD-BEARING AND SURVIVES PRETTIER HERE. This
 * is text-then-element, which is the shape that already renders correctly on
 * production in the two screens it came from. It is NOT the
 * expression-then-text shape that Next 16 collapses (see the entitlement
 * sentence in `mailbox/page.tsx`) — do not "simplify" it into one.
 */
export function NoOrganisation() {
  return (
    <p className="text-sm text-muted-foreground">
      Create an organisation first.{" "}
      <Link href="/app/organisations/new" className="font-medium text-link hover:underline">
        New organisation
      </Link>
    </p>
  );
}
