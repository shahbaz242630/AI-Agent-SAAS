/**
 * The sidebar's icons, traced from the 2026-08-09 prototype.
 *
 * Inline SVG rather than an icon package: there are six of them, they never
 * change, and a dependency whose whole job is six paths costs more to keep
 * current than the paths do.
 *
 * ⚠️ DECORATIVE, SO `aria-hidden`. Every icon sits beside its own text label,
 * and a screen reader announcing "Home, image, Home" is worse than silence.
 */

import { moduleHref } from "@eva/types";

type IconProps = { className?: string | undefined };

function Icon({ className, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      aria-hidden
      focusable="false"
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      {children}
    </svg>
  );
}

function HomeIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 11l8-7 8 7v9a1 1 0 0 1-1 1h-4v-6h-6v6H5a1 1 0 0 1-1-1z" />
    </Icon>
  );
}

function InvoicesIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="5" y="3" width="14" height="18" rx="2" />
      <path d="M9 8h6M9 12h6M9 16h3" />
    </Icon>
  );
}

function ClientsIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 19c.9-3 3-4.6 5.5-4.6s4.6 1.6 5.5 4.6" />
      <circle cx="17" cy="9" r="2.4" />
      <path d="M16.5 14.6c1.9.4 3.3 1.6 4 4" />
    </Icon>
  );
}

/** A paper plane — the only icon that depicts an action rather than a place. */
function ChasingIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M21 4L3 10.5l7 3.2L13.5 21z" />
      <path d="M21 4L10 13.7" />
    </Icon>
  );
}

export function SettingsIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2 2M16.7 16.7l2 2M18.7 5.3l-2 2M7.3 16.7l-2 2" />
    </Icon>
  );
}

/**
 * The account menu's disclosure arrow (2026-08-18).
 *
 * ⚠️ IT POINTS UP WHEN THE MENU IS SHUT, WHICH IS THE RIGHT WAY ROUND. This
 * menu opens UPWARDS — it lives at the bottom of the sidebar and there is no
 * room below it — so the arrow shows where the panel will appear rather than
 * where the list would unroll. Caller flips it with a class when open.
 */
export function ChevronIcon({ className }: IconProps) {
  return (
    <svg
      aria-hidden
      focusable="false"
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="m6 15 6-6 6 6" />
    </svg>
  );
}

export function SignOutIcon() {
  return (
    <svg
      aria-hidden
      focusable="false"
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-sidebar-faint"
    >
      <path d="M9 5H5v14h4" />
      <path d="M13 12h8m-3-3 3 3-3 3" />
    </svg>
  );
}

/**
 * The padlock on the account menu's Change password row (2026-08-10).
 *
 * ⚠️ IT EXISTS BECAUSE `/change-password` WOULD OTHERWISE BE UNREACHABLE — the
 * same defect `SettingsTabs` was built to fix one slice ago. The design puts
 * this link in the landing page's signed-in dropdown, and the landing page is
 * blocked on the founder, so without it the route could only be reached by
 * typing the URL. A screen nobody can get to is a screen that does not exist.
 *
 * ⚠️ IT IS NO LONGER THE WHOLE CONTROL. Until 2026-08-18 this padlock WAS the
 * link, unlabelled, beside the user's name; the founder moved it into the
 * account menu where it sits next to the words "Change password". The icon is
 * decoration now, and the label carries the meaning.
 */
export function PasswordIcon() {
  return (
    <svg
      aria-hidden
      focusable="false"
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-sidebar-faint"
    >
      <rect x="5" y="10" width="14" height="10" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

/**
 * Keyed by href so the icon and the nav item cannot drift apart — a positional
 * array would silently shift every icon by one the day a section is inserted.
 * A missing key renders no icon rather than throwing.
 *
 * ⚠️ KEYED BY HREF IS ONLY DRIFT-PROOF IF BOTH SIDES BUILD THE HREF THE SAME
 * WAY, AND FOR FIVE WEEKS THEY DID NOT. `PRODUCT_NAV` builds its hrefs with
 * `moduleHref`; these keys were typed out as `/app/invoices` and
 * `/app/reminders`. When the products got their own URLs the nav moved and the
 * keys did not, so Invoices and Chasing lost their icons — and because a
 * missing key renders nothing rather than throwing, the failure the comment
 * above describes as safe is exactly what hid it. Nothing failed; the sidebar
 * just quietly went half-illustrated.
 *
 * Computed keys are the fix: there is now one source for the segment, and a
 * renamed product moves the nav item and its icon together.
 */
export const NAV_ICONS: Readonly<Record<string, (props: IconProps) => React.JSX.Element>> = {
  "/app": HomeIcon,
  /* ⚠️ A PRODUCT'S OWN HOME HAD NO ICON AT ALL, and unlike the two above that
     is not the route move — `PRODUCT_NAV` has always built a Home item and
     this map has never had a key for it. Left alone it is one unillustrated
     row sitting above four illustrated ones, with its label starting where no
     other label starts. Founder: say if you would rather it stayed bare. */
  [moduleHref("email_credit_controller")]: HomeIcon,
  [moduleHref("email_credit_controller", "invoices")]: InvoicesIcon,
  [moduleHref("email_credit_controller", "chasing")]: ChasingIcon,
  "/app/clients": ClientsIcon,
  "/app/settings/reminders": SettingsIcon,
};
