import { useEffect, useState } from "react";
import { ExternalLink } from "./ExternalLink";
import {
  type CopilotKitSignInPage,
  copilotKitSignInPage,
} from "./localEvalCli";
import { StatusLine } from "./SetupProgress";

/** How often the window asks for the page while the sign-in waits. */
const ASK_EVERY_MS = 500;

/**
 * A CopilotKit sign-in waiting on the person's browser, with a way to finish it and a way out.
 *
 * The CLI opens its approval page by itself. An account in several organizations can land on the
 * CopilotKit dashboard instead, after choosing an organization, and the sign-in then waits with
 * nothing to approve. Opening the same page again shows the approval. So this shows the code the
 * page carries, a link that opens that page again in the default browser, and Cancel, which stops
 * the CLI's sign-in.
 */
export function CopilotKitSignInWait({
  attempt,
  waiting,
  before = waiting,
  onCancel,
}: {
  /** The sign-in being waited on (`signInToCopilotKit`). */
  attempt: string;
  /** What is said while it waits. */
  waiting: string;
  /**
   * What is said until the CLI has opened a page. It checks for a sign-in it already has first, and
   * opens nothing when it finds one.
   */
  before?: string;
  onCancel: () => void;
}) {
  const [page, setPage] = useState<CopilotKitSignInPage | null>(null);

  useEffect(() => {
    let current = true;
    let next: ReturnType<typeof setTimeout> | null = null;
    const ask = () => {
      copilotKitSignInPage(attempt)
        .then(
          (found) => {
            if (current && found) setPage(found);
          },
          () => {},
        )
        .finally(() => {
          if (current) next = setTimeout(ask, ASK_EVERY_MS);
        });
    };
    ask();
    return () => {
      current = false;
      if (next) clearTimeout(next);
    };
  }, [attempt]);

  return (
    <>
      <StatusLine>{page ? waiting : before}</StatusLine>
      {page && (
        <>
          <p className="footnote">
            Check that the page shows this code:{" "}
            <strong className="sign-in-code">{page.userCode}</strong>
          </p>
          <p className="fallback">
            Didn't open?{" "}
            <ExternalLink href={page.url}>Open the sign-in page</ExternalLink>
          </p>
          <p className="footnote">
            If your browser shows a dashboard after you choose an organization,
            open the sign-in page again.
          </p>
        </>
      )}
      <div className="row">
        <button type="button" className="quiet" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </>
  );
}
