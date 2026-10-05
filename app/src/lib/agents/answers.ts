import type { QueryClient } from "@tanstack/react-query";
import { pluginsPageQueryOptions } from "@/lib/plugins/queries";
import { describeBot, describeBots, describeGrantableSkills } from "./proposal";
import { agentListQueryOptions } from "./queries";

/**
 * What the three reading tools answer with, fetched at the moment they are asked.
 *
 * THE BUG THIS SHAPE EXISTS TO PREVENT, which the very first conversation with this feature
 * produced. The obvious wiring is a `useQuery` in the component and handlers closing over
 * `data ?? []`. A run starts the moment somebody sends a message, and the model called
 * `list_bot_skills` before that query had come back — so the handler read an empty array and
 * answered "No skills exist here yet", which the Bot then told the person as a fact about their
 * deployment. Nine skills existed.
 *
 * An empty list and an unloaded list are different answers and must not share a code path.
 * `ensureQueryData` returns what is cached when there is something cached and fetches when there is
 * not, so a tool called in the first second of a run waits for the truth rather than inventing a
 * tidier one — and a run that never calls these pays for neither.
 *
 * They live here rather than inline in the hooks so that a test can call them cold, against a query
 * client nothing has rendered, which is precisely the state the bug needed.
 */

export async function answerListBots(client: QueryClient): Promise<string> {
  return describeBots(await client.ensureQueryData(agentListQueryOptions()));
}

export async function answerReadBot(
  client: QueryClient,
  name: string,
): Promise<string> {
  const wanted = name.trim().toLowerCase();
  const known = await client.ensureQueryData(agentListQueryOptions());
  const agent = known.find(
    (candidate) => candidate.name.toLowerCase() === wanted,
  );
  if (!agent) {
    return `There is no coworker called ${name} that this person can see. Call list_bots for the ones there are.`;
  }
  return describeBot(agent);
}

export async function answerListBotSkills(
  client: QueryClient,
): Promise<string> {
  const page = await client.ensureQueryData(pluginsPageQueryOptions());
  return describeGrantableSkills(page.skills);
}
