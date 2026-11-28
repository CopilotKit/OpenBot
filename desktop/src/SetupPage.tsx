import type { ReactNode } from "react";
import { Lockup } from "./Sections";

/** A standalone setup task: identity, heading, scrollable content, then its stable action. */
export function SetupPage({
  heading,
  lede,
  children,
  footer,
  className = "",
  rail,
}: {
  heading: ReactNode;
  lede?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  className?: string;
  /** A task’s progress history and identity, instead of a standalone page heading. */
  rail?: ReactNode;
}) {
  return (
    <main className={`page-first-main${rail ? " with-progress-rail" : ""}`}>
      {rail}
      <div
        className={`sheet connection-sheet setup-layout page-first ${rail ? "" : "standalone-layout "}${className}`}
      >
        {!rail && (
          <>
            <Lockup />
            <header className="setup-header-block">
              <h1>{heading}</h1>
              {lede && <p className="lede">{lede}</p>}
            </header>
          </>
        )}
        <div className="setup-body">
          <div className="setup-content">{children}</div>
        </div>
        {footer && <footer className="setup-footer">{footer}</footer>}
      </div>
    </main>
  );
}
