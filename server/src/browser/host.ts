import { isPersonBrowserId } from "@openbot/shared/openbot-browser";
import type { ComputerGateway } from "../computer/gateway";
import {
  type EgressPolicy,
  pushEgressPolicy,
} from "../computer/policy-network";
import type { ComputerProvider } from "../computer/provider";
import type { BrowserComputers } from "./routes";

/**
 * The computer provider, with each person's browser found where it runs.
 *
 * Unset `browserUrl`: a person's browser is a computer like a Bot's, named for the person (browser/person.ts), so the
 * provider already carries it, on the shared computer, in a supervisor's container or in a Sandbox. Set, it is the one
 * computer OpenBot Desktop runs on the person's own machine (`OPENBOT_BROWSER_URL`, its host-side local Chrome computer),
 * while Bots' computers stay where they were. Wrapped here, under the policy push, so every way a computer is reached
 * (the browser routes, the live screen, the network policy pushed on the way) reaches the same one.
 */
export function withPersonBrowsers(
  provider: ComputerProvider,
  browserUrl: string | undefined,
): ComputerProvider {
  if (!browserUrl) return provider;
  return Object.assign(Object.create(provider) as ComputerProvider, {
    locate: (botId: string) =>
      isPersonBrowserId(botId)
        ? Promise.resolve(browserUrl)
        : provider.locate(botId),
    // A host process OpenBot Desktop keeps running with the stack: there is nothing to wake, and what the browser itself
    // is doing, the computer's own state route says.
    status: (botId: string) =>
      isPersonBrowserId(botId)
        ? Promise.resolve({ botId, state: "ready" as const })
        : provider.status(botId),
    // Unknown rather than the Bots' computer's run, which would say nothing about this one.
    sessionOf: async (botId: string) =>
      isPersonBrowserId(botId) ? undefined : provider.sessionOf?.(botId),
  });
}

/** People's browsers reached through the computer gateway, whose provider carries them (`withPersonBrowsers`): every
 * address checked as a computer's, and the person's network policy pushed on the way (`withPolicyPushOnWake`). */
export function gatewayBrowserComputers(
  gateway: Pick<ComputerGateway, "locate" | "status">,
): BrowserComputers {
  return {
    locate: (computerId) => gateway.locate(computerId),
    running: async (computerId) =>
      (await gateway.status(computerId)).state === "ready",
  };
}

/** How long a policy pushed to the host-side computer is trusted before it is pushed again: the computer can restart
 * with the stack, and one restarted holds none. The provider's own re-push interval for a run it cannot name. */
const REPUSH_MS = 30_000;

/**
 * People's browsers on OpenBot Desktop's host-side computer when this OpenBot has no computer for Bots at all, so there
 * is no gateway to go through. The person's network policy goes ahead of the browser, as the provider's push on wake
 * sends a Bot's: the computer holds it in memory and refuses the browser's connections until one arrives. A failed push
 * is logged, never thrown, for the same reason.
 */
export function directBrowserComputers(input: {
  browserUrl: string;
  token?: string;
  policy: EgressPolicy;
  fetchImpl?: typeof fetch;
}): BrowserComputers {
  const pushed = new Map<string, number>();
  return {
    locate: async (computerId) => {
      const last = pushed.get(computerId);
      if (last === undefined || Date.now() - last >= REPUSH_MS) {
        try {
          await pushEgressPolicy(input.browserUrl, computerId, input.policy, {
            ...(input.token ? { token: input.token } : {}),
            ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
          });
          pushed.set(computerId, Date.now());
        } catch (error) {
          console.warn(
            JSON.stringify({
              type: "egress-policy-push-on-wake-failed",
              botId: computerId,
              note: "The computer refuses its network connections until a policy reaches it.",
              error: error instanceof Error ? error.message : String(error),
            }),
          );
        }
      }
      return input.browserUrl;
    },
    running: async () => true,
  };
}
