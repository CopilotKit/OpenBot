/**
 * GET TROUBLESHOOTING LOGS, FROM THE WEB APP.
 *
 * A person whose reply broke, or whose screen said something went wrong, needs one file to send in.
 * It covers the last half hour and nothing more, has every key, token, password, cookie and email
 * address taken out before it is saved, and says so at the top. The ids that find a failure in the
 * server's logs (request, account and organization ids) are kept.
 *
 * In a browser the page writes the file itself, from the problems it kept (`lib/desktop/problems.ts`),
 * and hands it over as a download. Nothing is fetched to make it.
 *
 * Inside OpenBot Desktop the desktop app saves its own file, which already lists these problems
 * beside its own logs, and shows it in Finder or Explorer (the page plugin's `save_logs`). A desktop
 * app older than that command refuses it, and the page writes its own file then.
 */

import {
  frontEndRelease,
  KEPT_FOR_MS,
  type KeptProblem,
  problemClockNow,
  recentProblems,
} from "@/lib/desktop/problems";
import { invokeDesktop } from "@/lib/desktop/queries";
import { desktopShell } from "@/lib/desktop/shell";
import { redact, redactKeepingIds } from "./redact";

/** The sentence at the top of the file, saying what was taken out and what was kept. */
export const REDACTION_NOTE =
  "Redacted before saving: API keys, tokens, passwords, cookies and email addresses. Request, account and organization ids are kept, so a failure can be found in the server's logs.";

/** OpenBot Desktop's answer to `save_logs` when it has the command and couldn't save the file. */
export const DESKTOP_COULD_NOT_SAVE =
  "OpenBot couldn't save the troubleshooting logs. Try again.";

/** What the person reads once the file is saved, after where it was saved. */
export const REMOVED =
  "Keys, tokens, passwords, cookies and email addresses were removed before it was saved.";

/** A request id as the desktop app accepts one (desktop/src-tauri/src/page_problems.rs). */
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

/** What the file says about where it was made, beside the problems. */
export type TroubleshootingContext = {
  /** When it was made, milliseconds since the epoch. */
  now: number;
  /** The address the web app was opened at (`location.origin`). */
  address: string;
  /** The web app's own release (`appVersion()`). */
  frontEnd: string | undefined;
  /** The release the server runs, as it answered for the current person. */
  server: string | null | undefined;
  organizationId: string | undefined;
  personId: string | undefined;
  browser: string;
  problems: KeptProblem[];
};

/** `1.2s`, `30s`, `2m 05s`, as the desktop app says a wait. */
function took(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds >= 60)
    return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
  if (ms % 1000 === 0 || seconds >= 10) return `${seconds}s`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** The request id, when it reads as one, with any credential in it replaced. */
function requestIdOf(id: string | undefined): string | undefined {
  const trimmed = id?.trim();
  return trimmed && REQUEST_ID.test(trimmed)
    ? redactKeepingIds(trimmed)
    : undefined;
}

/**
 * One problem in one line, without when, in the words the desktop app's file uses
 * (`Problem::said` in desktop/src-tauri/src/page_problems.rs).
 */
export function said({ problem }: KeptProblem): string {
  const requestId = requestIdOf(problem.requestId);
  const message = redact(problem.message?.trim() ?? "");
  switch (problem.kind) {
    case "request": {
      const path = redactKeepingIds(problem.path ?? "");
      const id = requestId ? `request id ${requestId}` : "no request id";
      const waited = problem.waitedMs;
      const answer =
        problem.outcome === "failed"
          ? `answered ${problem.status}, ${id}`
          : problem.outcome === "no-answer"
            ? waited === undefined
              ? "no answer"
              : `no answer (gave up after ${took(waited)})`
            : problem.outcome === "slow"
              ? waited === undefined
                ? "no answer yet"
                : `no answer yet after ${took(waited)}`
              : "failed";
      return `request ${problem.method ?? "GET"} ${path}: ${answer}`;
    }
    case "page-error": {
      const where = problem.source?.trim();
      return where
        ? `page error: ${message || "It said nothing about itself."} (at ${redact(where)})`
        : `page error: ${message || "It said nothing about itself."}`;
    }
    case "unhandled-rejection":
      return `unhandled rejection: ${message || "It said nothing about itself."}`;
    case "run": {
      const words = message || "The run failed without saying why.";
      return requestId
        ? `run failed: ${words} (request id ${requestId})`
        : `run failed: ${words}`;
    }
  }
}

/** The file, as text: what it is, what was removed, where it came from, then the problems. */
export function troubleshootingText(context: TroubleshootingContext): string {
  const made = new Date(context.now).toISOString();
  const from = new Date(context.now - KEPT_FOR_MS).toISOString();
  const problems = context.problems
    .filter(({ at }) => context.now - at < KEPT_FOR_MS)
    .sort((a, b) => a.at - b.at);
  return [
    "OpenBot troubleshooting logs",
    REDACTION_NOTE,
    `Made ${made}, covering the last 30 minutes (from ${from}).`,
    "",
    `Address: ${redact(context.address)}`,
    `Front end: ${context.frontEnd ?? "version not known"}`,
    `OpenBot: ${context.server ? redactKeepingIds(context.server) : "version not known"}`,
    `Organization: ${context.organizationId ? redactKeepingIds(context.organizationId) : "not known"}`,
    `Account: ${context.personId ? redactKeepingIds(context.personId) : "not known"}`,
    `Browser: ${redact(context.browser)}`,
    "",
    "Problems the app met:",
    ...(problems.length === 0
      ? ["None in the last 30 minutes."]
      : problems.map(
          (kept) => `${new Date(kept.at).toISOString()} ${said(kept)}`,
        )),
    "",
  ].join("\n");
}

/** The file's name: `openbot-troubleshooting-2026-11-24T10-30-00Z.txt`, in UTC. */
export function troubleshootingFileName(now: number): string {
  const stamp = new Date(now)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replace(/:/g, "-");
  return `openbot-troubleshooting-${stamp}.txt`;
}

/** Hand `text` to the person as a download named `name`. Nothing leaves the page. */
function download(name: string, text: string): void {
  const url = URL.createObjectURL(
    new Blob([text], { type: "text/plain;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.rel = "noopener";
  link.style.display = "none";
  document.body.append(link);
  link.click();
  link.remove();
  // Safari starts the download after the click returns; the address is let go once it has.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** What the person is told once the logs are saved. */
export type SavedLogs = { where: "desktop" | "download"; said: string };

/** Who is asking, from the current person's own answer (`currentUserQueryOptions`). */
export type TroubleshootingPerson = {
  id?: string;
  openbotVersion?: string | null;
};

/**
 * Save the troubleshooting logs: inside OpenBot Desktop, its own file; anywhere else, or with a
 * desktop app that refuses, this page's file as a download.
 */
export async function saveTroubleshootingLogs(
  person: TroubleshootingPerson | undefined,
  organizationId: string | undefined,
): Promise<SavedLogs> {
  if (desktopShell() !== null) {
    try {
      await invokeDesktop("save_logs");
      return {
        where: "desktop",
        said: `Saved in OpenBot Desktop's log folder. ${REMOVED}`,
      };
    } catch (error) {
      // A desktop app that has the command but couldn't save says so in its own sentence, and that
      // is what the person is told. A desktop app older than the command refuses it in Tauri's
      // words, and the person still gets a file: this page's own.
      if (error === DESKTOP_COULD_NOT_SAVE)
        throw new Error(DESKTOP_COULD_NOT_SAVE);
    }
  }
  const now = problemClockNow();
  const name = troubleshootingFileName(now);
  download(
    name,
    troubleshootingText({
      now,
      address: location.origin,
      frontEnd: frontEndRelease(),
      server: person?.openbotVersion,
      organizationId,
      personId: person?.id,
      browser: navigator.userAgent,
      problems: recentProblems(),
    }),
  );
  return { where: "download", said: `Saved as ${name}. ${REMOVED}` };
}
