import type { Metadata } from "next";
import { IBM_Plex_Sans, IBM_Plex_Serif } from "next/font/google";
import Link from "next/link";
import "./globals.css";

const plexSans = IBM_Plex_Sans({
  variable: "--font-plex-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

const plexSerif = IBM_Plex_Serif({
  variable: "--font-plex-serif",
  subsets: ["latin"],
  weight: ["500", "600"],
});

export const metadata: Metadata = {
  title: "QuoteDesk — Answer every inbound RFQ",
  description: "AI estimator for metal fabrication: ingest, draft, approve, learn.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${plexSans.variable} ${plexSerif.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <header className="border-b border-[var(--line)] bg-[var(--panel)]/90 backdrop-blur-sm">
          <div className="mx-auto flex max-w-6xl items-center justify-between gap-6 px-4 py-3">
            <Link href="/" className="flex items-baseline gap-2">
              <span
                className="font-[family-name:var(--font-plex-serif)] text-xl font-semibold tracking-tight text-[var(--brand)]"
              >
                QuoteDesk
              </span>
              <span className="hidden text-xs text-[var(--ink-muted)] sm:inline">
                metal fabrication
              </span>
            </Link>
            <nav className="flex items-center gap-4 text-sm font-medium text-[var(--ink-muted)]">
              <Link href="/" className="hover:text-[var(--ink)]">
                Inbox
              </Link>
              <Link href="/rfqs/new" className="hover:text-[var(--ink)]">
                New RFQ
              </Link>
              <Link href="/history" className="hover:text-[var(--ink)]">
                History
              </Link>
              <Link href="/settings" className="hover:text-[var(--ink)]">
                Settings
              </Link>
              <Link
                href="/rfqs/new"
                className="rounded-md bg-[var(--brand)] px-3 py-1.5 text-white hover:bg-[var(--brand-hot)]"
              >
                Ingest
              </Link>
            </nav>
          </div>
        </header>
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">{children}</main>
      </body>
    </html>
  );
}
