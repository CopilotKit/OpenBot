import {
  type CopilotKitIntelligence,
  PlatformRequestError,
} from "@copilotkit/runtime/v2";
import { IntelligenceKnowingANewThread } from "@openbot/toolkit/copilotkit/agents";
import type { IntelligenceSettings } from "./config";
import {
  clearDesktopConnectionFailure,
  recordDesktopConnectionFailure,
} from "./desktop-connection-failure";
import { transientStatus } from "./intelligence-startup";

/**
 * The runtime entitlement read, held back until Intelligence has answered it once.
 *
 * The runtime client prints every failed entitlement read to the console as a multi-line object
 * before it throws, and it is read from many places: the boot check, the setup checklist (at boot
 * and on reads), the self-host banner, memory, and the runtime's own `/info`. While an Intelligence
 * installed beside this server is still starting (intelligence-startup.ts) every one of those reads
 * fails, so until a read has been answered 200, each first asks whether Intelligence answers, with a
 * bare request that prints nothing (`runtimeEntitlementStatus`), and fails as the client would have,
 * with the same `PlatformRequestError`, when it does not. From the first 200 on, reads go straight
 * to the client, and a failure after that is a real one the client is right to print.
 */
function quietUntilAnswered(client: CopilotKitIntelligence) {
  let answered = false;
  let asking: Promise<void> | undefined;
  const ask = async () => {
    let status: number;
    try {
      status = await runtimeEntitlementStatus({
        apiUrl: client.ɵgetApiUrl(),
        apiKey: client.ɵgetApiKey(),
      });
    } catch (error) {
      throw new PlatformRequestError(
        error instanceof Error ? error.message : String(error),
        502,
        true,
      );
    }
    if (status !== 200)
      throw new PlatformRequestError(
        `Runtime entitlement request failed with status ${status}`,
        status,
        transientStatus(status),
      );
    answered = true;
  };
  return async (read: () => unknown): Promise<unknown> => {
    if (!answered) {
      // Concurrent reads share one question.
      asking ??= ask().finally(() => {
        asking = undefined;
      });
      await asking;
    }
    return read();
  };
}

/** Observe the SDK's typed HTTP errors before runtime handlers turn them into generic 500s. */
export function observeIntelligenceAuthentication<
  T extends CopilotKitIntelligence,
>(client: T): T {
  const methods = new Map<PropertyKey, (...args: unknown[]) => unknown>();
  const quiet = quietUntilAnswered(client);
  return new Proxy(client, {
    get(target, property) {
      // Both getters and methods must keep the original receiver: the SDK owns #private fields.
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function" || property === "constructor")
        return value;
      const cached = methods.get(property);
      if (cached) return cached;
      const observed = (...args: unknown[]): unknown => {
        const result: unknown =
          property === "getRuntimeEntitlements"
            ? quiet(() => Reflect.apply(value, target, args))
            : Reflect.apply(value, target, args);
        if (!(result instanceof Promise)) return result;
        return result.then(
          (response: unknown) => {
            // Entitlements may be cached; optional Inspector reads can succeed without authentication.
            if (
              property !== "getRuntimeEntitlements" &&
              property !== "getInspectorMetadata"
            ) {
              clearDesktopConnectionFailure("intelligence");
            }
            return response;
          },
          (error: unknown) => {
            // A 403 can be a permissions or entitlement decision. Only rejected authentication
            // asks for a new credential, and only at this trusted Intelligence client boundary.
            if (
              error instanceof Error &&
              "status" in error &&
              error.status === 401
            ) {
              recordDesktopConnectionFailure({
                connection: "intelligence",
                code: "intelligence_authentication_failed",
              });
            }
            throw error;
          },
        );
      };
      methods.set(property, observed);
      return observed;
    },
  });
}

/**
 * The HTTP status Intelligence answers the runtime entitlement read with, asked without the runtime
 * client, which is still what reads the answer itself.
 *
 * The client prints every failed read to the console as a multi-line object before it throws
 * (`logger.error({ status, path }, "Runtime entitlement request failed")`, and its logger is
 * `console`). That is right for a read that should have worked, and wrong for the reads expected to
 * fail while Intelligence is still starting: `quietUntilAnswered` asks this first. Rejects, marked
 * `retryable`, when nothing answered at all. A 401 is observed here as the client's would be.
 */
export async function runtimeEntitlementStatus(
  settings: Pick<IntelligenceSettings, "apiUrl" | "apiKey">,
  timeoutMs = 5_000,
): Promise<number> {
  let response: Response;
  try {
    response = await fetch(
      `${settings.apiUrl.trim().replace(/\/+$/, "")}/api/entitlements/runtime`,
      {
        headers: {
          accept: "application/json",
          authorization: `Bearer ${settings.apiKey}`,
        },
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
  } catch (error) {
    throw Object.assign(
      new Error(
        `The backend did not answer (${error instanceof Error ? error.message : String(error)})`,
      ),
      { retryable: true },
    );
  }
  await response.body?.cancel().catch(() => {});
  if (response.status === 401) {
    recordDesktopConnectionFailure({
      connection: "intelligence",
      code: "intelligence_authentication_failed",
    });
  }
  return response.status;
}

/**
 * A client through which this deployment can ask Intelligence a question of its own.
 *
 * The runtime already holds one of these, built where it is mounted, and everything a conversation
 * does goes through that. This is for the questions OpenBot asks on its own account rather than on
 * a run's: whether a thread the browser remembers is still there, and whatever else later needs an
 * answer from the platform outside a turn.
 *
 * A second instance rather than a shared one, deliberately. The constructor stores its settings and
 * opens nothing — no socket, no handshake, no pool — so the cost is an object, while reaching into
 * the runtime for the client it built would tie this to the mounting order of a module that has no
 * other reason to care. The settings both read come from one place, which is the part that has to
 * agree.
 *
 * The same class as the runtime's, so a question whose "no" is ordinary (a thread the browser
 * remembers that is gone) is answered without the base client printing the "no" as a failure.
 */
export function createIntelligenceClient(
  settings: IntelligenceSettings,
): CopilotKitIntelligence {
  return observeIntelligenceAuthentication(
    new IntelligenceKnowingANewThread({
      apiUrl: settings.apiUrl,
      wsUrl: settings.gatewayWsUrl,
      apiKey: settings.apiKey,
    }),
  );
}
