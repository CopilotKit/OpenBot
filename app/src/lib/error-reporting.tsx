import type { ErrorComponentProps } from "@tanstack/react-router";
import { useEffect } from "react";
import { CompanySignInPage } from "@/components/auth/company-sign-in-page";
import { RouteError } from "@/components/layout/route-error";
import { UnavailablePage } from "@/components/layout/unavailable-page";
import { NoOrganizationPage } from "@/components/organizations/no-organization-page";
import type { AppErrorSource } from "@/lib/api/generated/model";
import { recordAppError } from "@/lib/api/generated/product-events/product-events";
import { idempotencyKey } from "@/lib/api/request";
import { heldOutBySso } from "@/lib/auth/held-out";
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

/** For a test: forget what this page has sent. */
export function resetAppErrorReports(): void {
  sentCount = 0;
  seenKinds.clear();
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

/** Tell OpenBot about an error the app did not handle. Never throws, never waits. */
export function reportAppError(source: AppErrorSource, error: unknown): void {
  const organization = currentOrganizationId();
  if (organization === undefined) return;
  if (typeof error === "object" && error !== null) {
    if (seenErrors.has(error)) return;
    seenErrors.add(error);
  }
  const report = described(error);
  const kind = JSON.stringify([
    report.type,
    report.message,
    report.stack?.split("\n")[1] ?? "",
  ]);
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

let installed = false;

/** Listens, once per page, for errors the page threw and promises nobody handled. */
export function installAppErrorReporting(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("error", (event) => {
    reportAppError("window_error", event.error ?? event.message);
  });
  window.addEventListener("unhandledrejection", (event) => {
    reportAppError("unhandled_rejection", event.reason);
  });
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
  // OpenBot holding off for now (an organization being moved, its database out of reach), in its own words.
  const unavailable = unavailableSaid(error);
  const answer = none || heldOut || unavailable !== undefined;
  useEffect(() => {
    // Somebody in no organization, or held out until they sign in through their company, or an organization that is
    // briefly unavailable, is an answer, not a fault: there is nothing to tell OpenBot.
    if (!answer) reportAppError("error_boundary", error);
  }, [error, answer]);
  // Wherever it was found, it is answered with its own page, never the router's error screen.
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
