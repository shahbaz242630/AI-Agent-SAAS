"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";
import { ownerForRoute } from "@/lib/product-owner";

/**
 * Root error boundary (Next.js global-error convention). Replaces the root
 * layout when active, so it must render its own <html>/<body> and cannot rely
 * on globals.css — hence inline styles. Reports the error to Sentry (a no-op
 * when Sentry is disabled) and shows a minimal generic fallback (BRD 14).
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    /**
     * ⚠️ TAGGED WITH THE PRODUCT, LIKE EVERY OTHER FAULT (Slice 3.0c). This is
     * the browser half, and it is the half a customer is actually looking at
     * when they pick up the phone. The pathname is read here rather than
     * through `usePathname()` because this boundary replaces the root layout —
     * there is no router context left to ask.
     */
    Sentry.captureException(error, {
      tags: {
        product:
          typeof window === "undefined" ? "unattributed" : ownerForRoute(window.location.pathname),
      },
    });
  }, [error]);

  return (
    <html lang="en-GB">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: "1rem",
          fontFamily: "system-ui, sans-serif",
          textAlign: "center",
          padding: "2rem",
        }}
      >
        <h1 style={{ fontSize: "1.5rem", fontWeight: 700 }}>Something went wrong</h1>
        <p style={{ color: "#666" }}>
          An unexpected error occurred. The team has been notified — please try again.
        </p>
        <button
          type="button"
          onClick={() => reset()}
          style={{
            padding: "0.5rem 1.25rem",
            borderRadius: "0.375rem",
            border: "1px solid #ccc",
            background: "#fff",
            cursor: "pointer",
          }}
        >
          Try again
        </button>
      </body>
    </html>
  );
}
