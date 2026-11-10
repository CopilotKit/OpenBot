import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";
import { ExternalLink } from "./ExternalLink";

/**
 * A failure, in both registers, wherever one happens.
 *
 * ONE IMPLEMENTATION, because there is one rule and every screen owes it: the sentence is the
 * headline and the real output lives behind a disclosure. A second copy is how one screen ends up
 * showing an engine dump as its title, and how another ends up rendering `[object Object]` because
 * it stringified a failure that was never a string.
 */
export type Problem = {
  said: string;
  detail?: string | null;
  connection?: "model" | "intelligence" | "installation" | null;
  database_reset?: string | null;
  /** Every volume a confirmed fresh-install reset removes, the database included. */
  leftover_reset?: string[] | null;
  /** Stopped containers that still hold those volumes, removed first by the same reset. */
  leftover_containers?: string[] | null;
};

/** Anything thrown, as a problem. A bare string keeps working and reads as it always did. */
export function asProblem(thrown: unknown): Problem {
  if (thrown && typeof thrown === "object" && "said" in thrown) {
    return thrown as Problem;
  }
  return { said: String(thrown) };
}

function SetupHelp() {
  // Whitelabel builds can choose their own support page. Never prefill it with error data.
  const url =
    import.meta.env.VITE_OPENBOT_SUPPORT_URL?.trim() ||
    "https://github.com/CopilotKit/OpenBot/issues/new/choose";
  return (
    <ExternalLink className="setup-help" href={url}>
      Get setup help
    </ExternalLink>
  );
}

/** What failed, as the troubleshooting logs say it: the sentence, then what lay beneath. */
export function failureText(problem: Problem): string {
  return problem.detail ? `${problem.said}\n${problem.detail}` : problem.said;
}

/**
 * Put text on the clipboard that is still being gathered. WebKit, the Mac's window, refuses a
 * clipboard write that comes after an await, because the click that allowed it is over. A
 * `ClipboardItem` handed a promise is written within the click and filled when the text arrives.
 */
async function copyWhenReady(text: Promise<string>): Promise<void> {
  if (typeof ClipboardItem !== "undefined" && navigator.clipboard.write) {
    await navigator.clipboard.write([
      new ClipboardItem({
        "text/plain": text.then(
          (said) => new Blob([said], { type: "text/plain" }),
        ),
      }),
    ]);
    return;
  }
  await navigator.clipboard.writeText(await text);
}

/**
 * Get troubleshooting logs, beside every failure and in the Status window: one block of text with
 * the version, the system, what failed, the container engine's details and the end of both logs,
 * redacted on the native side. Copy puts it on the clipboard; Save to a file writes it to the log
 * folder and shows it in Finder or Explorer. The person is told to paste it into their own AI
 * assistant, which is how the first person to hit a full Docker disk found out, and that keys,
 * passwords and their email are already taken out.
 */
export function TroubleshootingLogs({
  problem = null,
}: {
  problem?: Problem | null;
}) {
  const [busy, setBusy] = useState<"copy" | "save" | null>(null);
  const [copied, setCopied] = useState(false);
  const [said, setSaid] = useState<{ text: string; failed: boolean } | null>(
    null,
  );
  const failure = problem ? failureText(problem) : null;
  return (
    <div className="troubleshooting">
      <p>
        Paste these logs into the AI assistant you use, such as Claude or
        ChatGPT, and ask what went wrong. OpenBot takes out keys, passwords and
        your email address first.
      </p>
      <div className="row">
        <button
          type="button"
          className="quiet"
          disabled={busy !== null}
          onClick={async () => {
            setSaid(null);
            setBusy("copy");
            try {
              await copyWhenReady(
                invoke<string>("troubleshooting_logs", { failure }),
              );
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            } catch {
              setSaid({
                text: "Couldn't copy the logs. Try Save to a file.",
                failed: true,
              });
            } finally {
              setBusy(null);
            }
          }}
        >
          {busy === "copy"
            ? "Gathering logs…"
            : copied
              ? "Copied"
              : "Copy logs"}
        </button>
        <button
          type="button"
          className="quiet"
          disabled={busy !== null}
          onClick={async () => {
            setSaid(null);
            setBusy("save");
            try {
              await invoke("save_troubleshooting_logs", { failure });
              setSaid({ text: "Saved in the log folder.", failed: false });
            } catch {
              setSaid({
                text: "Couldn't save the logs. Try Copy logs.",
                failed: true,
              });
            } finally {
              setBusy(null);
            }
          }}
        >
          {busy === "save" ? "Gathering logs…" : "Save to a file"}
        </button>
      </div>
      {said && (
        <p className={said.failed ? "caution failed" : "caution"}>
          {said.text}
        </p>
      )}
    </div>
  );
}

/**
 * `onRetry`, where the screen has no other way to run what failed again: Try again, in the card.
 * The install behind the account step had none, and its failure sat there with nothing to press.
 */
export function Failure({
  problem,
  onRetry,
}: {
  problem: Problem;
  onRetry?: () => void;
}) {
  return (
    <div className="blocker" role="alert">
      <h2>That didn’t finish</h2>
      <p>{problem.said}</p>
      {onRetry && (
        <div className="row">
          <button type="button" onClick={onRetry}>
            Try again
          </button>
        </div>
      )}
      {/* The real output, kept but not the headline. Whoever is debugging opens this; the person
          reading the sentence above never has to. */}
      {problem.detail && (
        <details className="detail-of">
          <summary>Technical details</summary>
          <pre>{problem.detail}</pre>
        </details>
      )}
      <TroubleshootingLogs problem={problem} />
      <SetupHelp />
    </div>
  );
}

/**
 * The same two registers where a whole panel would be too much.
 *
 * Used inside the provider rows, which are small and already have a heading. The sentence reads as
 * a caution and the output is still one click away, so a sign-in that fails inside a card is no
 * less diagnosable than one that fails on its own screen.
 */
export function InlineFailure({ problem }: { problem: Problem }) {
  return (
    <div className="inline-failure" role="alert">
      <p className="caution">{problem.said}</p>
      {problem.detail && (
        <details className="detail-of">
          <summary>Technical details</summary>
          <pre>{problem.detail}</pre>
        </details>
      )}
      <SetupHelp />
    </div>
  );
}
