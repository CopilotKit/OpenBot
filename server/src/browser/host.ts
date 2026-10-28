import {
  BROWSER_ABSENCES,
  type BrowserAbsence,
  type BrowserWindow,
  isPersonBrowserId,
} from "@openbot/shared/openbot-browser";
import type { ComputerGateway } from "../computer/gateway";
import {
  type EgressPolicy,
  pushEgressPolicy,
} from "../computer/policy-network";
import { type ComputerProvider, ProviderError } from "../computer/provider";
import type { BrowserComputers, BrowserRouteDeps } from "./routes";

/**
 * What the person is told where a browser of their own cannot run here: every Bot shares the one computer.
 *
 * A PERSON'S BROWSER RUNS ONLY ON A COMPUTER OF ITS OWN. On the shared computer it would sit beside every Bot's
 * browser, in the container where a Bot may run a shell, and its profile holds what the person signed in to by hand: a
 * prompt-injected Bot could read their cookies off the disk. A supervisor's container and a Sandbox are made for the one
 * computer named, so the person's browser is alone there; OpenBot Desktop's host-side computer runs people's browsers
 * and no Bot. The computer refuses it too (agent-computer's `person-access.ts`), so neither can be talked into it alone.
 */
export const SHARED_COMPUTER =
  "This OpenBot can't open a browser of your own, because its Bots share one computer.";

/**
 * Why a person's browser cannot run on these computers, or null where it can: on OpenBot Desktop's host-side computer
 * (`browserUrl`), or on a provider that gives every computer named its own (`per-bot`). Null too where there is no
 * provider at all, which says nothing about sharing: the routes have no computers then, and say so their own way.
 */
export function personBrowserRefusal(
  provider: Pick<ComputerProvider, "isolation"> | undefined,
  browserUrl: string | undefined,
): string | null {
  if (browserUrl || !provider) return null;
  return provider.isolation === "per-bot" ? null : SHARED_COMPUTER;
}

/**
 * Where the browser routes find people's browsers here, and what the person is told about it: no computers, and why,
 * where their Bots share one computer (`personBrowserRefusal`); otherwise `computers`, with OpenBot Desktop's reason
 * for not running the person's own Chrome or Edge (`absent`) where it gave one. The server and the tests of its routes
 * both build the routes' half from this, so the two cannot disagree about where a person's browser may run.
 */
export function personBrowserPlace(input: {
  provider: Pick<ComputerProvider, "isolation"> | undefined;
  browserUrl: string | undefined;
  absent?: BrowserAbsence;
  computers: () => BrowserComputers;
}): Pick<BrowserRouteDeps, "computers" | "note"> {
  const refusal = personBrowserRefusal(input.provider, input.browserUrl);
  if (refusal) return { note: refusal };
  return {
    computers: input.computers(),
    ...(input.absent ? { note: BROWSER_ABSENCES[input.absent] } : {}),
  };
}

/**
 * The computer provider, with each person's browser found where it runs.
 *
 * Unset `browserUrl`: a person's browser is a computer like a Bot's, named for the person (browser/person.ts), so a
 * provider that gives each computer its own (a supervisor's container, a Sandbox) already carries it. The one shared
 * computer does not: there a person's browser is refused at `locate`, which every way of reaching it goes through, and
 * is never reported running. Set, it is the one computer OpenBot Desktop runs on the person's own machine
 * (`OPENBOT_BROWSER_URL`, its host-side local Chrome computer), while Bots' computers stay where they were. Wrapped
 * here, under the policy push, so every way a computer is reached (the browser routes, the live screen, the network
 * policy pushed on the way) reaches the same one.
 */
export function withPersonBrowsers(
  provider: ComputerProvider,
  browserUrl: string | undefined,
): ComputerProvider {
  const refusal = personBrowserRefusal(provider, browserUrl);
  if (refusal)
    return Object.assign(Object.create(provider) as ComputerProvider, {
      locate: (botId: string) =>
        isPersonBrowserId(botId)
          ? Promise.reject(new ProviderError(refusal))
          : provider.locate(botId),
      // Absent rather than unreachable: nothing of the person's runs here, and nothing is going to.
      status: (botId: string) =>
        isPersonBrowserId(botId)
          ? Promise.resolve({ botId, state: "absent" as const })
          : provider.status(botId),
      sessionOf: async (botId: string) =>
        isPersonBrowserId(botId) ? undefined : provider.sessionOf?.(botId),
    });
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

/**
 * Where a person's browser shows here, from where it runs, by the rule `withPersonBrowsers` finds it by: on OpenBot
 * Desktop's host-side local Chrome computer (`browserUrl`, which Desktop sets for nothing else) it is the person's own
 * Chrome or Edge, a native window on their desktop; on the computers Bots run on it is a cloud browser the app shows as
 * a screen. Known before the browser is opened, so the sidebar's Browser button knows what one click does.
 */
export function personBrowserShows(
  browserUrl: string | undefined,
): BrowserWindow {
  return browserUrl ? "native" : "screen";
}

/** People's browsers reached through the computer gateway, whose provider carries them (`withPersonBrowsers`, given the
 * same `browserUrl`): every address checked as a computer's, and the person's network policy pushed on the way
 * (`withPolicyPushOnWake`). */
export function gatewayBrowserComputers(
  gateway: Pick<ComputerGateway, "locate" | "status">,
  browserUrl: string | undefined,
): BrowserComputers {
  return {
    shows: personBrowserShows(browserUrl),
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
    shows: personBrowserShows(input.browserUrl),
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
