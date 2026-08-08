import { AppNav } from "./app-nav";

/**
 * The shell every signed-in screen shares (Slice 1.9).
 *
 * ⚠️ THERE WAS NO `/app` LAYOUT AT ALL UNTIL THIS. Twelve screens each ended
 * with a hand-written footer of two or three links, so the only reliable way
 * around the product was to know the URLs — and a screen's set of onward links
 * depended on whoever wrote it last.
 *
 * Deliberately thin: no data fetching, no auth check. Each page already verifies
 * the session and redirects, and doing it here as well would double every page's
 * calls to `/organisations` for a guard that is not this layer's job. The proxy
 * guards the route; the page proves the session.
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <AppNav />
      {children}
    </div>
  );
}
