import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { type AgentProfile, agentListQueryOptions } from "@/lib/agents/queries";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { client } from "@/lib/client";
import { clearActivity } from "./activity";
import { type ActionPolicy, computerKeys } from "./queries";

/**
 * Stopping frees the container; resetting also deletes the browser profiles on it; updating moves
 * the computer onto the current image and keeps the profiles.
 */
export type ComputerAction = "stop" | "reset" | "update";

const PAST: Record<ComputerAction, string> = {
  stop: "stopped",
  reset: "reset",
  update: "updated",
};

function invalidateComputers(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: computerKeys.all });
}

/** What a reset names: whose computer, as `person:<id>` or `bot:<id>`, and on a shared one the Bot's seat. */
export type ResetTarget = { computer: string; botId?: string };

/**
 * The Bots whose Activity in this browser ran on the computer a reset deleted.
 *
 * A reset names a computer, and Activity is kept per Bot, so this is the one place the two meet. It
 * used to forget a Bot only when the reset named one, and only the calls the resetting page had read,
 * which on Admin is none. An isolated Bot's computer is that Bot's. A seat on a person's computer is
 * that Bot's on it. A whole person's computer runs every Bot they use apart from isolated ones, and on
 * a shared computer that is every Bot. Another person's computer ran nothing this browser lists: its
 * Activity is that person's own.
 */
export async function botsOnReset(
  queryClient: QueryClient,
  target: ResetTarget,
): Promise<string[]> {
  const split = target.computer.indexOf(":");
  const kind = target.computer.slice(0, split);
  const id = target.computer.slice(split + 1);
  if (split === -1 || !id) return target.botId ? [target.botId] : [];
  if (kind === "bot") return [target.botId ?? id];
  if (kind !== "person") return [];
  const me = await queryClient
    .ensureQueryData(currentUserQueryOptions())
    .then((user) => user?.id)
    .catch(() => undefined);
  // Not knowing who is signed in, forget too much rather than show what ran on a deleted machine.
  if (me !== undefined && me !== id) return [];
  if (target.botId) return [target.botId];
  const lists = await Promise.all(
    [false, true].map((hidden) =>
      queryClient
        .ensureQueryData(agentListQueryOptions(hidden))
        .catch((): AgentProfile[] => []),
    ),
  );
  return lists
    .flat()
    .filter((bot) => !(bot.isolated && bot.isolationActive))
    .map((bot) => bot.id);
}

/**
 * An administrator stopping, resetting or updating one computer from the list.
 *
 * Named by whose computer it is, not by a Bot: the computer on the list is somebody else's, and the
 * Bot routes act on the asker's own. `botId` names one seat on a shared computer.
 */
export function setComputerStateMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: {
      computer: string;
      botId?: string;
      action: ComputerAction;
    }) => {
      await client("/api/computers/fleet", {
        method: "POST",
        body: {
          action: variables.action,
          computer: variables.computer,
          ...(variables.botId ? { botId: variables.botId } : {}),
        },
        fallback: `The computer could not be ${PAST[variables.action]}.`,
      });
    },
    /** A reset deletes the profile those commands ran on; a stop keeps it, so only reset forgets. */
    onSuccess: async (_result, variables) => {
      if (variables.action === "reset")
        for (const bot of await botsOnReset(queryClient, variables))
          clearActivity(bot);
      return invalidateComputers(queryClient);
    },
  });
}

/**
 * Replace the whole policy.
 *
 * A PUT rather than a patch because the rules are ordered and evaluated as a set: sending a
 * difference would leave the server deciding where a new rule belongs, and where a deny sits
 * relative to an allow is most of what a policy means.
 */
/**
 * A rule written from a sentence in plain English, recorded with the save that adds it: the trail
 * keeps what the admin asked for beside the rule that was enforced.
 */
export type PolicyAuthoring = { source: "english"; text: string };

export function saveActionPolicyMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (
      next: ActionPolicy & { authoring?: PolicyAuthoring },
    ): Promise<ActionPolicy> =>
      client("/api/computers/policy", "policy", {
        method: "PUT",
        body: next,
        fallback: "The boundary could not be saved.",
      }),
    onSuccess: () => invalidateComputers(queryClient),
  });
}
