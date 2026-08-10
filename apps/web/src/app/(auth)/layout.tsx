/**
 * The auth group owns no layout of its own.
 *
 * ⚠️ IT USED TO CENTRE A `max-w-sm` COLUMN INSIDE A `<main>`, and that is now
 * `AuthFrame`'s job — the design's split screen needs the full viewport,
 * including the charcoal half, so a wrapper that boxed its children would have
 * left the panel nowhere to go. Each page renders its own frame, and the frame
 * renders the one `<main>`.
 */
export default function AuthLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
