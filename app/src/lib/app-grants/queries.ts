import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";
import type { GrantSetCheck } from "./translate";

/** One action a change turns on or off, with what it does. */
export type ChangedAction = {
  ref: string;
  name: string;
  effect: "read" | "write";
  destructive: boolean;
};

/** An action the replay names, with how often the Bot called it and when it last did. */
export type ReplayedAction = ChangedAction & {
  calls: number;
  lastCalled: string;
};

/** What the change would have meant for this Bot's own recent use of the app. */
export type AppGrantReplay = {
  /** The Bot's calls to this app on the trail, each counted once. */
  calls: number;
  /** Runs it was offered tools in. */
  runs: number;
  /** The oldest row replayed, or null with nothing to replay. */
  since: string | null;
  /** Actions the change takes away that the Bot called, most called first. */
  removedUsed: ReplayedAction[];
  callsLost: number;
  /** Actions it was refused for not having, that the change gives it. */
  refusedGiven: ReplayedAction[];
  callsGained: number;
  /** Writes the change gives it that it never called or tried. */
  addedUnusedWrites: Pick<ChangedAction, "ref" | "name" | "destructive">[];
  addedUnusedReads: number;
};

export type AppGrantPreview = {
  check: GrantSetCheck;
  warning: string | null;
  /** Against what the Bot holds now. */
  changes: { added: ChangedAction[]; removed: ChangedAction[] };
  /** Null where OpenBot keeps no readable trail to replay. */
  report: AppGrantReplay | null;
};

export const appGrantKeys = {
  all: ["app-grants"] as const,
  replay: (agentId: string, app: string, grants: readonly string[]) =>
    ["app-grants", "replay", { agentId, app, grants }] as const,
};

/** What a set of actions would change for this Bot, replayed over its own recent calls. Writes nothing. */
export function appGrantsReplayQueryOptions(
  agentId: string,
  app: string,
  grants: readonly string[],
) {
  return queryOptions({
    queryKey: appGrantKeys.replay(agentId, app, grants),
    queryFn: async (): Promise<AppGrantPreview> =>
      (
        await client(
          `/api/plugins/for/${encodeURIComponent(agentId)}/apps/${encodeURIComponent(app)}/grants/replay`,
          {
            method: "POST",
            body: { grants },
            fallback: "Couldn't test these actions against recent activity.",
          },
        )
      ).json(),
    retry: false,
    /*
     * Not kept once the draft closes. The answer is worked out against what the Bot holds now, and
     * a saved change makes it wrong: the same sentence written again must be replayed again, not
     * shown the diff from before the save while the new one loads.
     */
    gcTime: 0,
  });
}
