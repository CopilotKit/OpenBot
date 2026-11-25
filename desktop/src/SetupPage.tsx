import type { ReactNode } from "react";
import { Lockup } from "./Sections";

/** A standalone setup task: identity, heading, scrollable content, then its stable action. */
export function SetupPage({
  heading,
  lede,
  children,
  footer,
  className = "",
}: {
  heading: ReactNode;
  lede?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  return (
    <main className="page-first-main">
      <div
        className={`sheet connection-sheet setup-layout page-first standalone-layout ${className}`}
      >
        <Lockup />
        <header className="setup-header-block">
          <h1>{heading}</h1>
          {lede && <p className="lede">{lede}</p>}
        </header>
        <div className="setup-body">
          <div className="setup-content">{children}</div>
        </div>
        {footer && <footer className="setup-footer">{footer}</footer>}
      </div>
    </main>
  );
}
