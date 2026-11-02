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
 * one). A person's computer is asked which Bots those are, as the policy push asks it. None running
 * is "not checked": a computer that has not started yet is not a broken one.
 *
 * Only running computers, without waking any. Each list, ask, policy read and push has five seconds;
 * a healthy fleet's total time scales with its size. Serial delivery bounds the active work to one.
 */
export function createComputerCheck(input: {
  provider?: Pick<ComputerProvider, "list">;
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
    if (running.length === 0) return "not_checked";
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
    inFlight ??= check().finally(() => {
      // A timed-out store/provider may not support cancellation. Keep its verdict until that
      // operation settles, so rechecks cannot stack more work behind a hung read or push.
      const release = () => {
        inFlight = undefined;
      };
      void operation.then(release, release);
    });
    return inFlight;
  };
}
