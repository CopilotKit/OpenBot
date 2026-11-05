import {
  askWhileIntelligenceStarts,
  INTELLIGENCE_STARTUP_WINDOW_MS,
  type StartupClock,
  transientStatus,
} from "./intelligence-startup";
import type { RuntimeEntitlementResponse } from "./self-host-banner";

/**
 * Whether Intelligence will let this deployment use what it is licensed for, said once at boot.
 *
 * A self-hosted Intelligence without a licence answers every runtime entitlement read with
 * `RUNTIME_ENTITLEMENTS_SELF_HOSTED_MISCONFIGURED`, and the features it gates, memory first, are
 * then refused quietly: conversations still run, nothing fails loudly, and nothing in OpenBot's own
 * log says why recall is empty. The licence belongs to Intelligence's own deployment rather than to
 * OpenBot's, which is the part that is easy to miss, so the line says where it goes.
 *
 * Read at boot and never blocks start-up; an Intelligence still starting is waited out first (see
 * `reportIntelligenceEntitlement`). The self-host banner reads the same answer on page loads, but
 * only while the banner is enabled, so it cannot be the thing that reports this.
 */
export type EntitlementWarning = {
  type: "intelligence-entitlement-not-ready";
  status: string;
  code?: string;
  message?: string;
  fix: string;
};

/**
 * The codes this build has advice for. A Map, because the code is Intelligence's string rather than
 * this deployment's: a plain object answers `toString` with an inherited function, which is truthy
 * and so takes the place of the sentence the `||` below exists to supply.
 */
const FIXES: ReadonlyMap<string, string> = new Map([
  [
    "RUNTIME_ENTITLEMENTS_SELF_HOSTED_MISCONFIGURED",
    "Intelligence has no valid licence. Give Intelligence's own deployment a COPILOTKIT_LICENSE_TOKEN " +
      "(its Helm chart takes it as appApi.licenseSecret, or externalSecrets.secrets.license); setting it " +
      "on OpenBot alone is not enough. Until then memory and other licensed features are refused.",
  ],
  [
    "RUNTIME_ENTITLEMENTS_SELF_HOSTED_EXPIRED",
    "Intelligence's licence has expired. Renew it and replace COPILOTKIT_LICENSE_TOKEN on Intelligence's " +
      "deployment. Until then memory and other licensed features are refused.",
  ],
  [
    "RUNTIME_ENTITLEMENTS_MANAGED_UNAVAILABLE",
    "Managed Intelligence could not resolve this project's entitlement just now. This is usually " +
      "temporary; licensed features may be refused until it recovers.",
  ],
]);

/** The warning a response deserves, or null when Intelligence answers ready and active. */
export function entitlementWarning(
  response: RuntimeEntitlementResponse,
): EntitlementWarning | null {
  if (response.status === "ready") {
    if (response.entitlement.active) return null;
    return {
      type: "intelligence-entitlement-not-ready",
      status: "inactive",
      fix: "Intelligence answers that this deployment's entitlement is not active, so licensed features such as memory are refused.",
    };
  }
  const code = response.error?.code;
  return {
    type: "intelligence-entitlement-not-ready",
    status: response.status,
    ...(code ? { code } : {}),
    ...(response.error?.message ? { message: response.error.message } : {}),
    fix:
      (code && FIXES.get(code)) ||
      "Intelligence did not confirm this deployment's entitlement, so licensed features such as memory may be refused.",
  };
}

/** What one read found: Intelligence's answer, or why there was none and whether that may pass. */
type Read =
  | { kind: "answer"; response: RuntimeEntitlementResponse }
  | { kind: "failed"; reason: string; status?: number; transient: boolean };

/**
 * A failed read. The runtime client's errors carry the HTTP status and whether it may pass
 * (`PlatformRequestError`), as do the ones the client boundary throws while Intelligence has not
 * answered yet (intelligence-client.ts). Anything else never reached an answer either, so it is
 * treated the same way.
 */
function failed(error: unknown): Read {
  const { status, retryable } =
    error !== null && typeof error === "object"
      ? (error as { status?: unknown; retryable?: unknown })
      : {};
  const code = typeof status === "number" ? status : undefined;
  return {
    kind: "failed",
    reason: error instanceof Error ? error.message : String(error),
    ...(code !== undefined ? { status: code } : {}),
    transient:
      typeof retryable === "boolean"
        ? retryable
        : code === undefined || transientStatus(code),
  };
}

/** Intelligence refused the key: a bad key, or, on a first install, one its bootstrap has not stored yet. */
function refused(read: Read): boolean {
  return read.kind === "failed" && (read.status === 401 || read.status === 403);
}

/**
 * Ask, and log what was found. Resolves either way and never throws.
 *
 * An Intelligence still starting (nothing answers, a 5xx, a timeout) is asked again until
 * `INTELLIGENCE_STARTUP_WINDOW_MS` closes, with one quiet line saying so, and only an answer still
 * unreadable then is reported as unreadable. A refused key (401, 403) is reported at once, unless
 * Intelligence was seen starting first: on a first install its bootstrap stores the key only after
 * the migrations, so the same good key is refused for a few seconds in between.
 *
 * Given a client from intelligence-client.ts, the reads that fail while Intelligence starts never
 * reach the runtime client's own read, which prints every failure: see `quietUntilAnswered`.
 */
export async function reportIntelligenceEntitlement(
  options: {
    entitlements: () => Promise<RuntimeEntitlementResponse>;
    log?: (message: string) => void;
    /** The one quiet line said while waiting. */
    note?: (message: string) => void;
  } & StartupClock,
): Promise<void> {
  const log = options.log ?? ((message: string) => console.warn(message));
  const note = options.note ?? ((message: string) => console.info(message));
  const { sleep, now } = options;
  const windowMs = options.windowMs ?? INTELLIGENCE_STARTUP_WINDOW_MS;
  const minutes = Math.round(windowMs / 60_000);

  const readOnce = async (): Promise<Read> => {
    try {
      return { kind: "answer", response: await options.entitlements() };
    } catch (error) {
      return failed(error);
    }
  };
  let seenStarting = false;
  const read = async (): Promise<Read> => {
    const found = await readOnce();
    if (found.kind === "failed" && found.transient) seenStarting = true;
    return found;
  };

  try {
    const found = await askWhileIntelligenceStarts(
      read,
      (answer) =>
        answer.kind === "failed" &&
        (answer.transient || (seenStarting && refused(answer))),
      {
        windowMs,
        ...(sleep ? { sleep } : {}),
        ...(now ? { now } : {}),
        onWaiting: (answer) =>
          note(
            JSON.stringify({
              type: "intelligence-entitlement-waiting",
              ...(answer.kind === "failed" ? { reason: answer.reason } : {}),
              message: `Waiting for Intelligence to finish starting. OpenBot asks again for up to ${minutes} minutes before reporting it.`,
            }),
          ),
      },
    );
    if (found.kind === "answer") {
      const warning = entitlementWarning(found.response);
      if (warning) log(JSON.stringify(warning));
      return;
    }
    log(
      JSON.stringify({
        type: "intelligence-entitlement-unreadable",
        reason: refused(found)
          ? `Intelligence refused this deployment's INTELLIGENCE_API_KEY (HTTP ${found.status}).`
          : found.reason,
        ...(found.status !== undefined ? { status: found.status } : {}),
        ...(seenStarting ? { waitedMinutes: minutes } : {}),
      }),
    );
  } catch (error) {
    // Only a logger or the clock can throw here, and the boot check still never takes the server down.
    log(
      JSON.stringify({
        type: "intelligence-entitlement-unreadable",
        reason: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}
