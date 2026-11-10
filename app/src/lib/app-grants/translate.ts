import { client } from "@/lib/client";

/** What is wrong with one action the model named. */
export type GrantActionProblem = { action: string; message: string };

/** Whether every action named is one the app offers now, and what is wrong with each that isn't. */
export type GrantSetCheck =
  | { ok: true }
  | { ok: false; error: string; problems: GrantActionProblem[] };

/**
 * One Bot's actions in one app, chosen by the deployment's model from an admin's description.
 *
 * `explanation` is a second reading of the set by a call that never saw the description, so it says
 * what the set lets the Bot do rather than what was asked for. Null when the set doesn't check.
 * `summary` is the same reading in one sentence. `otherApps` names other apps the description
 * mentioned, which this set does not touch. `warning` is set when the set destroys things or gives
 * nothing at all.
 */
export type AppGrantTranslation = {
  /** The names the model chose, as it wrote them. */
  actions: string[];
  /** The refs of the ones the app offers. */
  grants: string[];
  otherApps: string[];
  summary: string | null;
  explanation: string | null;
  check: GrantSetCheck;
  warning: string | null;
};

/**
 * Description in, actions out. A plain function rather than a mutation: nothing is saved and nothing
 * is cached. The server records the request on the trail; saving the actions is the admin's own act.
 */
export async function translateAppGrants(variables: {
  agentId: string;
  app: string;
  text: string;
}): Promise<AppGrantTranslation> {
  const response = await client(
    `/api/plugins/for/${encodeURIComponent(variables.agentId)}/apps/${encodeURIComponent(variables.app)}/grants/translate`,
    {
      method: "POST",
      body: { text: variables.text },
      fallback:
        "Couldn't choose the actions. Try again, or turn them on by hand.",
    },
  );
  return (await response.json()) as AppGrantTranslation;
}
