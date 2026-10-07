import * as React from "react";
import { Link } from "react-router-dom";

/** pattern public-card: centred card, practice logo, no navigation and no PHI. */
export function PublicCard({
  title,
  children,
  footer,
}: {
  title: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <div className="grid min-h-full place-items-center bg-canvas px-4 py-12">
      <main className="grid w-full max-w-[440px] gap-6">
        <div
          className="text-[22px] font-extrabold tracking-[-0.02em] text-ink"
          data-testid="practice-logo"
        >
          Agile EMR
        </div>
        <section className="grid gap-6 bg-surface p-8">
          <h1 className="text-h1 text-ink">{title}</h1>
          {children}
        </section>
        {footer}
        <p className="text-small text-ink-2" data-testid="legal-links">
          <Link to="/legal/privacy" className="hover:underline">
            Privacy notice
          </Link>{" "}
          ·{" "}
          <Link to="/legal/terms" className="hover:underline">
            Terms
          </Link>{" "}
          ·{" "}
          <Link to="/legal/accessibility" className="hover:underline">
            Accessibility
          </Link>
        </p>
      </main>
    </div>
  );
}
