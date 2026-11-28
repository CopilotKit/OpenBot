import { invoke } from "@tauri-apps/api/core";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { Failure, type Problem } from "./Problem";

/**
 * The setup window never goes blank because its page broke.
 *
 * On a Mac after an update the setup window stayed a plain ground with nothing on it, across two
 * launches. Nothing caught a screen that failed to draw: React then takes every screen away and
 * leaves the ground behind them (`.backdrop`), and nothing reached the Desktop log. Now a screen
 * that fails shows "OpenBot hit a problem" in its place, with Reload and the troubleshooting logs,
 * and the error goes to the Desktop log (`page_error`), as do uncaught errors and promises rejected
 * with nothing to catch them.
 */

/** Where an error came from, as the log says it. */
type Kind = "screen failed to draw" | "uncaught error" | "unhandled rejection";

/** The most errors a page sends the log, and the most of each. */
const MOST_REPORTS = 20;
const MOST_CHARS = 4_000;

let reported = 0;
const seen = new Set<string>();

/** An error to the Desktop log: once each, a bounded few per page, never thrown, never awaited. */
export function reportPageError(
  kind: Kind,
  message: string,
  stack?: string | null,
): void {
  const key = `${kind}\n${message}`;
  if (seen.has(key) || reported >= MOST_REPORTS) return;
  seen.add(key);
  reported += 1;
  invoke("page_error", {
    kind,
    message: message.slice(0, MOST_CHARS),
    stack: stack ? stack.slice(0, MOST_CHARS) : null,
  }).catch(() => {});
}

/** Anything thrown, as words: an Error's own, a failure's sentence, or what it prints as. */
function described(thrown: unknown): { message: string; stack: string | null } {
  if (thrown instanceof Error)
    return {
      message: `${thrown.name}: ${thrown.message}`,
      stack: thrown.stack ?? null,
    };
  if (thrown && typeof thrown === "object" && "said" in thrown)
    return { message: String((thrown as { said: unknown }).said), stack: null };
  try {
    return { message: JSON.stringify(thrown) ?? String(thrown), stack: null };
  } catch {
    return { message: String(thrown), stack: null };
  }
}

/**
 * Uncaught errors and unhandled rejections in this page, to the Desktop log. The function returned
 * stops listening.
 */
export function watchPageErrors(target: Window = window): () => void {
  const onError = (event: ErrorEvent) => {
    const { message, stack } = described(event.error ?? event.message);
    reportPageError("uncaught error", message, stack);
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    const { message, stack } = described(event.reason);
    reportPageError("unhandled rejection", message, stack);
  };
  target.addEventListener("error", onError);
  target.addEventListener("unhandledrejection", onRejection);
  return () => {
    target.removeEventListener("error", onError);
    target.removeEventListener("unhandledrejection", onRejection);
  };
}

function reload() {
  window.location.reload();
}

/** What the person reads when a screen failed to draw. */
export const PAGE_PROBLEM_HEADING = "OpenBot hit a problem";
export const PAGE_PROBLEM_SAID =
  "This window stopped working. Reload it to carry on.";

/** The sheet in place of the screen that failed: the setup window's own failure box. */
function PageProblem({ error }: { error: unknown }) {
  const problem: Problem = {
    said: PAGE_PROBLEM_SAID,
    detail: described(error).message,
  };
  return (
    <main>
      <div className="sheet">
        <h1>{PAGE_PROBLEM_HEADING}</h1>
        <Failure problem={problem} onRetry={reload} retryLabel="Reload" />
      </div>
    </main>
  );
}

/** The last resort, if the sheet itself fails: the same words and Reload, with nothing else. */
function PlainPageProblem() {
  return (
    <main>
      <div className="sheet">
        <h1>{PAGE_PROBLEM_HEADING}</h1>
        <p className="lede">{PAGE_PROBLEM_SAID}</p>
        <div className="row">
          <button type="button" onClick={reload}>
            Reload
          </button>
        </div>
      </div>
    </main>
  );
}

type Props = { children: ReactNode; fallback?: "sheet" | "plain" };
type State = { error: unknown; failed: boolean };

/**
 * Every screen of the setup window, caught: one that fails to draw shows `PageProblem` in its
 * place, and the error goes to the Desktop log.
 */
export class PageErrorBoundary extends Component<Props, State> {
  state: State = { error: null, failed: false };

  static getDerivedStateFromError(error: unknown): State {
    return { error, failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    const { message, stack } = described(error);
    const where = info.componentStack?.trim();
    reportPageError(
      "screen failed to draw",
      message,
      [stack, where && `In:\n${where}`].filter(Boolean).join("\n"),
    );
  }

  render() {
    if (!this.state.failed) return this.props.children;
    if (this.props.fallback === "plain") return <PlainPageProblem />;
    return (
      <PageErrorBoundary fallback="plain">
        <PageProblem error={this.state.error} />
      </PageErrorBoundary>
    );
  }
}
