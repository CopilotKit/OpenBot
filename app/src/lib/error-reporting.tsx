import type { ErrorComponentProps } from "@tanstack/react-router";
import { useEffect } from "react";
import { CompanySignInPage } from "@/components/auth/company-sign-in-page";
import { PendingDeletionPage } from "@/components/auth/pending-deletion-page";
import { RouteError } from "@/components/layout/route-error";
import { UnavailablePage } from "@/components/layout/unavailable-page";
import { NoOrganizationPage } from "@/components/organizations/no-organization-page";
import { pendingDeletionRefusal } from "@/lib/account-deletion/queries";
import type { AppErrorSource } from "@/lib/api/generated/model";
import { recordAppError } from "@/lib/api/generated/product-events/product-events";
import { idempotencyKey } from "@/lib/api/request";
import { heldOutBySso } from "@/lib/auth/held-out";
import { recordProblem } from "@/lib/desktop/problems";
import { desktopShell } from "@/lib/desktop/shell";
import { appVersion } from "@/lib/error-details";
import { askAgainAfterMs, unavailableSaid } from "@/lib/load-failure";
import { currentOrganizationId } from "@/lib/organizations/current";
import { inNoOrganization } from "@/lib/organizations/in-no-organization";

/**
 * ERRORS THE APP DID NOT HANDLE, TOLD TO OPENBOT.
 *
 * The router's error screen, an error the page threw, and a promise nobody handled each send one
 * report to this OpenBot's own server (recordAppError), which forwards it with the rest of its
 * product telemetry. The browser holds no telemetry key and decides nothing about consent: where
 * telemetry is off the server accepts the report and drops it, as it does a result view
 * (`product-telemetry.ts`). The server also scrubs the message and the stack before anything leaves.
 *
 * Best effort and bounded: a report is sent with keepalive and waited on by nobody, the same error
 * is sent once however many times it surfaces (React's development mode draws an error screen
 * twice, and a caught render error can also reach `window`), and a page sends at most ten. Before
 * the person's organization is known (signing in) there is nobody to send it for, so nothing is.
 */

const MAX_REPORTS = 10;
const MAX_MESSAGE = 2048;
const MAX_STACK = 12288;
let sentCount = 0;
const seenErrors = new WeakSet<object>();
const seenKinds = new Set<string>();

/**
 * For a test: forget what this page has sent, and stop listening, so the next test's page (a test
 * file's own DOM) is listened on afresh.
 */
export function resetAppErrorReports(): void {
  sentCount = 0;
  seenKinds.clear();
  recordedKinds.clear();
  uninstall?.();
  uninstall = null;
}

function described(error: unknown): {
  type: string;
  message: string;
  stack?: string;
} {
  if (error instanceof Error) {
    return {
      type: (error.name || "Error").slice(0, 128),
      message: String(error.message ?? "").slice(0, MAX_MESSAGE),
      ...(typeof error.stack === "string" && error.stack
        ? { stack: error.stack.slice(0, MAX_STACK) }
        : {}),
    };
  }
  if (typeof error === "string")
    return { type: "Error", message: error.slice(0, MAX_MESSAGE) };
  // Anything else thrown is not described: an object can hold what somebody wrote.
  return { type: "Error", message: `A ${typeof error} was thrown` };
}

/** Which error this is, for sending one report however many times it surfaces. */
function kindOf(report: ReturnType<typeof described>): string {
  return JSON.stringify([
    report.type,
    report.message,
    report.stack?.split("\n")[1] ?? "",
  ]);
}

/** The most different errors one page records; past it, they are counted afresh. */
const MAX_RECORDED_KINDS = 500;
const recordedErrors = new WeakSet<object>();
const recordedKinds = new Set<string>();

/**
 * The error is also kept for the troubleshooting logs, and inside OpenBot Desktop handed to its log
 * (`lib/desktop/problems.ts`), once, as the report is: its name and message, and where it was thrown
 * when that is known. This happens before the person's organization is known too, because signing in
 * can break as well.
 */
function recordForTroubleshooting(
  source: AppErrorSource,
  error: unknown,
  where: string | undefined,
): void {
  if (typeof error === "object" && error !== null) {
    if (recordedErrors.has(error)) return;
    recordedErrors.add(error);
  }
  const report = described(error);
  const kind = kindOf(report);
  if (recordedKinds.has(kind)) return;
  if (recordedKinds.size >= MAX_RECORDED_KINDS) recordedKinds.clear();
  recordedKinds.add(kind);
  recordProblem({
    kind:
      source === "unhandled_rejection" ? "unhandled-rejection" : "page-error",
    message: `${report.type}: ${report.message}`,
    ...(where ? { source: where } : {}),
  });
}

/**
 * Where an error the page threw was thrown, as "file:line:column", when the browser said. The file's
 * query and fragment are left out.
 */
export function thrownAt(event: ErrorEvent): string | undefined {
  const file = (event.filename ?? "").split(/[?#]/, 1)[0] ?? "";
  // WebKit names a script with no file of its own "undefined".
  if (!file || file === "undefined") return undefined;
  return event.lineno ? `${file}:${event.lineno}:${event.colno ?? 0}` : file;
}

/**
 * Tell OpenBot about an error the app did not handle. Never throws, never waits. `where` is where it
 * was thrown, when known (`thrownAt`).
 */
export function reportAppError(
  source: AppErrorSource,
  error: unknown,
  where?: string,
): void {
  recordForTroubleshooting(source, error, where);
  const organization = currentOrganizationId();
  if (organization === undefined) return;
  if (typeof error === "object" && error !== null) {
    if (seenErrors.has(error)) return;
    seenErrors.add(error);
  }
  const report = described(error);
  const kind = kindOf(report);
  if (seenKinds.has(kind) || sentCount >= MAX_REPORTS) return;
  seenKinds.add(kind);
  sentCount += 1;
  const version = appVersion();
  recordAppError(
    organization,
    {
      source,
      ...report,
      surface: desktopShell() ? "desktop" : "web",
      ...(version ? { appVersion: version } : {}),
    },
    { "Idempotency-Key": idempotencyKey() },
    { keepalive: true },
  ).catch(() => {
    // A report that could not be delivered is not the person's problem, and is not retried.
  });
}

/** Stops the listening `installAppErrorReporting` started, or null while it has not. */
let uninstall: (() => void) | null = null;

/** Listens, once per page, for errors the page threw and promises nobody handled. */
export function installAppErrorReporting(): void {
  if (uninstall || typeof window === "undefined") return;
  const onError = (event: ErrorEvent) =>
    reportAppError(
      "window_error",
      event.error ?? event.message,
      thrownAt(event),
    );
  const onRejection = (event: PromiseRejectionEvent) =>
    reportAppError("unhandled_rejection", event.reason);
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  uninstall = () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
  };
}

/**
 * The app's error screen for a route, reporting the error it shows once. OpenBot's own screen
 * (`components/layout/route-error.tsx`), which first loads again a part of the app that couldn't be
 * fetched, never the router's "Something went wrong!" box.
 */
export function ReportedErrorComponent(props: ErrorComponentProps) {
  const { error } = props;
  const none = inNoOrganization(error);
  const heldOut = heldOutBySso(error);
  // The person's account is scheduled to be deleted: every request but reading and cancelling it says so.
  const pending = pendingDeletionRefusal(error);
  // OpenBot holding off for now (an organization being moved, its database out of reach), in its own words.
  const unavailable = unavailableSaid(error);
  const answer = none || heldOut || pending || unavailable !== undefined;
  useEffect(() => {
    // Somebody in no organization, or held out until they sign in through their company, or whose account is to be
    // deleted, or an organization that is briefly unavailable, is an answer, not a fault: there is nothing to tell
    // OpenBot.
    if (!answer) reportAppError("error_boundary", error);
  }, [error, answer]);
  // Wherever it was found, it is answered with its own page, never the router's error screen.
  if (pending) return <PendingDeletionPage />;
  if (heldOut) return <CompanySignInPage refusal={error.message} />;
  if (none) return <NoOrganizationPage />;
  if (unavailable !== undefined)
    return (
      <UnavailablePage
        reset={props.reset}
        retryAfterMs={askAgainAfterMs(error) ?? 0}
        said={unavailable}
      />
    );
  return <RouteError {...props} />;
}
