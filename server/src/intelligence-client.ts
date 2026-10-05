import { CopilotKitIntelligence } from "@copilotkit/runtime/v2";
import type { IntelligenceSettings } from "./config";
import {
  clearDesktopConnectionFailure,
  recordDesktopConnectionFailure,
} from "./desktop-connection-failure";

/** Observe the SDK's typed HTTP errors before runtime handlers turn them into generic 500s. */
export function observeIntelligenceAuthentication<
  T extends CopilotKitIntelligence,
>(client: T): T {
  const methods = new Map<PropertyKey, (...args: unknown[]) => unknown>();
  return new Proxy(client, {
    get(target, property) {
      // Both getters and methods must keep the original receiver: the SDK owns #private fields.
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function" || property === "constructor")
        return value;
      const cached = methods.get(property);
      if (cached) return cached;
      const observed = (...args: unknown[]): unknown => {
        const result: unknown = Reflect.apply(value, target, args);
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
 */
export function createIntelligenceClient(
  settings: IntelligenceSettings,
): CopilotKitIntelligence {
  return observeIntelligenceAuthentication(
    new CopilotKitIntelligence({
      apiUrl: settings.apiUrl,
      wsUrl: settings.gatewayWsUrl,
      apiKey: settings.apiKey,
    }),
  );
}
