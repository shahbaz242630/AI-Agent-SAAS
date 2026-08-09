import type { Metadata } from "next";
import { Bricolage_Grotesque, Figtree } from "next/font/google";
import "./globals.css";

/**
 * Two families, two jobs (2026-08-09 design handoff).
 *
 * ⚠️ THE DISPLAY FACE IS FOR MONEY AND TITLES ONLY. Bricolage Grotesque is a
 * variable-optical-size display face; set it at 13px for body text and it turns
 * a screen full of invoice rows into something harder to scan, not easier.
 * Figtree carries every figure a customer reads at speed.
 */
const display = Bricolage_Grotesque({
  variable: "--font-display-family",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

const body = Figtree({
  variable: "--font-body-family",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Eva — AI Business Communications Platform",
  description:
    "Eva is a modular AI communications platform for UK small businesses: invoice chasing, lead follow-up and AI reception.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en-GB" className={`${display.variable} ${body.variable} h-full antialiased`}>
      {/* ⚠️ `tabular-nums` ON THE WHOLE APP, DELIBERATELY. Money and counts sit
          in columns on every screen, and proportional digits make a column of
          amounts jitter — the reader's eye stops trusting the alignment before
          they consciously notice why. */}
      <body className="flex min-h-full flex-col tabular-nums">{children}</body>
    </html>
  );
}
