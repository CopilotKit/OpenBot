import {
  botsOn,
  type EgressPolicy,
  pushEgressPolicy,
} from "../computer/policy-network";
import type { ComputerProvider } from "../computer/provider";
import type { WebBotAuth } from "../web-bot-auth";
import type { SetupStatus } from "./checklist";

/**
 * Whether the Bot computers work, for the setup checklist's computer row.
 *
 * Ready means every running computer took the network policy of each Bot it carries, which is the
 * authenticated round trip every action starts with (a computer refuses connections until it has
 * one). A person's computer is asked which Bots those are, as the policy push asks it.
 *
 * None running is "not checked" where a provider makes computers: one that has not started yet is
 * not a broken one, and asking would wake it. The one shared computer is different, and is the
 * personal edition's only computer. It is always running: what starts and stops on it is each Bot's
 * browser, which closes after sitting idle. Its list is that computer answering, with the token
 * every action carries, so it is Ready with no browser open. Before, a Bot that had just used it, or
 * whose browser had closed since, left the row saying no computer had started yet.
 *
 * Only running computers, without waking any. Each list, ask, policy read and push has five seconds;
 * a healthy fleet's total time scales with its size. Serial delivery bounds the active work to one.
 */
/** The longest a hung operation holds back the next check. */
export const RELEASE_AFTER_MS = 60_000;

export function createComputerCheck(input: {
  provider?: Pick<ComputerProvider, "list"> &
    Partial<Pick<ComputerProvider, "isolation">>;
  controls: () =>
    | { policyForBot: (botId: string) => Promise<EgressPolicy> }
    | undefined;
  token?: string;
  webBotAuth?: WebBotAuth;
  fetchImpl?: typeof fetch;
}): () => Promise<SetupStatus> {
  let inFlight: Promise<SetupStatus> | undefined;
  let operation: Promise<unknown> = Promise.resolve();
  const bounded = <T>(work: Promise<T>): Promise<T> => {
    operation = work;
    let timer: ReturnType<typeof setTimeout>;
    return Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("The computer check did not answer.")),
          5_000,
        );
        timer.unref?.();
      }),
    ]).finally(() => clearTimeout(timer));
  };
  const check = async (): Promise<SetupStatus> => {
    if (!input.provider) return "needs_setup";
    const computers = await bounded(input.provider.list());
    const running = computers.filter(
      (computer) => computer.status === "running" && computer.url,
    );
    if (running.length === 0)
      return input.provider.isolation === "shared" ? "ready" : "not_checked";
    const controls = input.controls();
    if (!controls) return "not_checked";
    for (const computer of running) {
      if (!computer.url) continue;
      const bots = await bounded(
        botsOn(computer, {
          ...(input.token ? { token: input.token } : {}),
          fetchImpl: input.fetchImpl ?? fetch,
        }),
      );
      for (const botId of bots) {
        const policy = await bounded(controls.policyForBot(botId));
        await bounded(pushEgressPolicy(computer.url, botId, policy, input));
      }
    }
    return "ready";
  };
  return () => {
    if (inFlight) return inFlight;
    const current: Promise<SetupStatus> = check().finally(() => {
      // A timed-out store/provider may not support cancellation. Keep its verdict until that
      // operation settles, so rechecks cannot stack more work behind a hung read or push, but no
      // longer than RELEASE_AFTER_MS: an operation that never settles would otherwise pin the row
      // to that verdict until a restart, however long ago the computer recovered.
      const release = () => {
        clearTimeout(timer);
        if (inFlight === current) inFlight = undefined;
      };
      const timer = setTimeout(release, RELEASE_AFTER_MS);
      timer.unref?.();
      void operation.then(release, release);
    });
    inFlight = current;
    return current;
  };
}
