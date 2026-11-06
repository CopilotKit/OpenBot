import {
  type BrowserWindow,
  isPersonBrowserId,
} from "@openbot/shared/openbot-browser";
import {
  botSeat,
  type ComputerKey,
  type ComputerSeat,
} from "../computer/computer-key";
import { computerTokenOf } from "../computer/computer-token";
import type { ComputerGateway } from "../computer/gateway";
import {
  type EgressPolicy,
  pushEgressPolicy,
} from "../computer/policy-network";
import { type ComputerProvider, ProviderError } from "../computer/provider";
import type { Edition } from "../edition";
import type { BrowserComputers, BrowserRouteDeps } from "./routes";

/**
 * What the person is told where a browser of their own cannot run here: every Bot shares the one computer.
 *
 * A PERSON'S BROWSER RUNS ONLY ON A COMPUTER OF ITS OWN. On the shared computer it would sit beside every Bot's
 * browser, in the container where a Bot may run a shell, and its profile holds what the person signed in to by hand: a
 * prompt-injected Bot could read their cookies off the disk. A supervisor's container and a Sandbox are made for the one
 * computer named, so the person's browser is alone there; a host-side computer started with `OPENBOT_BROWSER_URL` runs
 * people's browsers and no Bot. The computer refuses it too (agent-computer's `person-access.ts`), so neither can be
 * talked into it alone.
 *
 * The personal edition's one computer is the exception, as it is for Record (`botRecordRefusal`): every Bot on it is the
 * one person's, and they already sign in to sites in those Bots' browsers there, so their own browser runs there too,
 * shown in the page as a hosted one is. That computer is started as theirs in the personal edition
 * (`COMPUTER_PERSON_ID` with `OPENBOT_EDITION`) and allows it for the same reason.
 */
export const SHARED_COMPUTER =
  "This OpenBot can't open a browser of your own, because its Bots share one computer.";

/**
 * Why a person's browser cannot run on these computers, or null where it can: on a host-side computer of people's
 * browsers (`browserUrl`), on a provider that gives every computer named its own (`per-bot`), or on the personal
 * edition's one computer, whose every Bot is the one person's. Null too where there is no provider at all, which says
 * nothing about sharing: the routes have no computers then, and say so their own way.
 */
export function personBrowserRefusal(
  provider: Pick<ComputerProvider, "isolation"> | undefined,
  browserUrl: string | undefined,
  edition: Edition = "team",
): string | null {
  if (browserUrl || !provider || edition === "personal") return null;
  return provider.isolation === "shared" ? SHARED_COMPUTER : null;
}

/**
 * What the person is told where Record in a Bot's browser cannot run here: every Bot shares the one computer.
 *
 * RECORD IN A BOT'S BROWSER NEEDS A COMPUTER THE BOT DOES NOT SHARE. Record hands the Recorder in the Bot's browser the
 * person's own connection, which it keeps in the Bot's profile on disk until Stop, and a recording it has not sent yet
 * stays there after. On the shared computer every other Bot's shell (`/exec`) can read that profile, so a
 * prompt-injected Bot would hold a live connection into the person's Learning space. The person's own browser is
 * refused there for the same reason (`SHARED_COMPUTER`), and the computer refuses Record there too (agent-computer's
 * `bot-browser-host.ts`), so neither can be talked into it alone.
 *
 * The personal edition's one computer is the exception: every Bot on it is the one person's, as on a person's own
 * computer (`per-person`), so the connection sits beside only their own Bots' work. Its computer is started as theirs
 * (`COMPUTER_PERSON_ID`, scripts/start.sh) and allows Record for the same reason.
 */
export const SHARED_COMPUTER_RECORD =
  "This OpenBot can't record in a Bot's browser, because its Bots share one computer.";

/**
 * Why Record in a Bot's browser cannot run on these computers, or null where it can: a provider that gives every person
 * a computer of their own (`per-person`), where a Bot's browser sits on the recording person's own computer, beside
 * only their own Bots, or on an isolated Bot's computer of its own; and in the personal edition, where the one shared
 * computer carries only the one person's Bots. Null too where there is no provider, where there is no Bot's browser to
 * record in.
 */
export function botRecordRefusal(
  provider: Pick<ComputerProvider, "isolation"> | undefined,
  edition: Edition = "team",
): string | null {
  if (!provider || edition === "personal") return null;
  return provider.isolation === "shared" ? SHARED_COMPUTER_RECORD : null;
}

/**
 * Where the browser routes find people's browsers here, and what the person is told about it: no computers, and why,
 * where their Bots share one computer (`personBrowserRefusal`); otherwise `computers`. The server and the tests of its
 * routes both build the routes' half from this, so the two cannot disagree about where a person's browser may run.
 */
export function personBrowserPlace(input: {
  provider: Pick<ComputerProvider, "isolation"> | undefined;
  browserUrl: string | undefined;
  edition?: Edition;
  computers: () => BrowserComputers;
}): Pick<BrowserRouteDeps, "computers" | "note"> {
  const refusal = personBrowserRefusal(
    input.provider,
    input.browserUrl,
    input.edition,
  );
  return refusal ? { note: refusal } : { computers: input.computers() };
}

/**
 * The computer provider, with each person's browser found where it runs.
 *
 * Unset `browserUrl`: a person's browser is a computer like a Bot's, named for the person (browser/person.ts), so a
 * provider that gives each computer its own (a supervisor's container, a Sandbox) already carries it. The one shared
 * computer does not, outside the personal edition: there a person's browser is refused at `locate`, which every way of
 * reaching it goes through, and is never reported running. Set, it is the host-side local Chrome computer on the
 * person's own machine (`OPENBOT_BROWSER_URL`, as `scripts/start.sh` starts it), while Bots' computers stay where they
 * were. Wrapped
 * here, under the policy push, so every way a computer is reached (the browser routes, the live screen, the network
 * policy pushed on the way) reaches the same one.
 */
export function withPersonBrowsers(
  provider: ComputerProvider,
  browserUrl: string | undefined,
  edition: Edition = "team",
): ComputerProvider {
  const refusal = personBrowserRefusal(provider, browserUrl, edition);
  if (refusal)
    return Object.assign(Object.create(provider) as ComputerProvider, {
      locate: (seat: ComputerSeat) =>
        isPersonBrowserId(seat.botId)
          ? Promise.reject(new ProviderError(refusal))
          : provider.locate(seat),
      // Absent rather than unreachable: nothing of the person's runs here, and nothing is going to.
      status: (seat: ComputerSeat) =>
        isPersonBrowserId(seat.botId)
          ? Promise.resolve({ botId: seat.botId, state: "absent" as const })
          : provider.status(seat),
      sessionOf: async (seat: ComputerSeat) =>
        isPersonBrowserId(seat.botId) ? undefined : provider.sessionOf?.(seat),
    });
  if (!browserUrl) return provider;
  return Object.assign(Object.create(provider) as ComputerProvider, {
    locate: (seat: ComputerSeat) =>
      isPersonBrowserId(seat.botId)
        ? Promise.resolve(browserUrl)
        : provider.locate(seat),
    // A host process kept running with the stack: there is nothing to wake, and what the browser itself
    // is doing, the computer's own state route says.
    status: (seat: ComputerSeat) =>
      isPersonBrowserId(seat.botId)
        ? Promise.resolve({ botId: seat.botId, state: "ready" as const })
        : provider.status(seat),
    // Unknown rather than the Bots' computer's run, which would say nothing about this one.
    sessionOf: async (seat: ComputerSeat) =>
      isPersonBrowserId(seat.botId) ? undefined : provider.sessionOf?.(seat),
    /*
     * A host-side computer is started with the deployment's token: it runs the person's own browsers and
     * no Bot, on their own machine. Bots' computers take whatever their provider gave them.
     */
    tokenFor: (key: ComputerKey, deploymentToken: string) =>
      key.kind === "bot" && isPersonBrowserId(key.botId)
        ? deploymentToken
        : (computerTokenOf(provider, key, deploymentToken) ?? deploymentToken),
  });
}

/**
 * Where a person's browser shows here, from where it runs, by the rule `withPersonBrowsers` finds it by: on a host-side
 * local Chrome computer (`browserUrl`, set for nothing else) it is the person's own Chrome or Edge, a native window on
 * their desktop; on the computers Bots run on (OpenBot Desktop's among them) it is a browser the app shows in the page,
 * as a screen. Known before the browser is opened, so the sidebar's Browser button knows what one click does.
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
  gateway: Pick<ComputerGateway, "locate" | "status" | "tokenFor">,
  browserUrl: string | undefined,
): BrowserComputers {
  return {
    shows: personBrowserShows(browserUrl),
    // A person's browser is a computer of its own, never a seat on the person's computer beside their Bots.
    locate: (computerId) => gateway.locate(botSeat(computerId)),
    tokenFor: (computerId) => gateway.tokenFor(botSeat(computerId)),
    running: async (computerId) =>
      (await gateway.status(botSeat(computerId))).state === "ready",
  };
}

/** How long a policy pushed to the host-side computer is trusted before it is pushed again: the computer can restart
 * with the stack, and one restarted holds none. The provider's own re-push interval for a run it cannot name. */
const REPUSH_MS = 30_000;

/**
 * People's browsers on a host-side computer when this OpenBot has no computer for Bots at all, so there
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
    // A host-side computer, started with the deployment's token: see `withPersonBrowsers`.
    tokenFor: () => input.token,
    running: async () => true,
  };
}
