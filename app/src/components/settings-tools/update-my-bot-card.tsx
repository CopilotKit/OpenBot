import { IconRobot } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { agentListQueryOptions } from "@/lib/agents/queries";
import type { SettingsToolCardProps } from "./registry";
import { SettingsChangeCard, settingsChangeOf } from "./settings-change-card";
import { AskedList } from "./update-my-settings-card";

/**
 * `update_my_bot`, drawn: the person asked a Bot to change one of their Bots, often itself, and this
 * is each field that moved, before and after, titled as the Bot's Setup page titles it.
 *
 * The rows are the server's (`changes` in the tool's output, from `personal-bot.ts`), the same rows
 * the approval card showed. The card is titled with the Bot's name and opens its Setup page. Before
 * it has an answer, the Bot is the one the call names, or the Bot making it when it names none.
 */

type BotOutput = { bot?: { id?: unknown; name?: unknown } };

/** The Bot the answer names, as `{ id, name }`, or nothing when it names none. */
function botOf(output: Record<string, unknown> | null) {
  const bot = (output as BotOutput | null)?.bot;
  return bot && typeof bot.id === "string" && typeof bot.name === "string"
    ? { id: bot.id, name: bot.name }
    : null;
}

export function UpdateMyBotCard({
  args,
  output,
  state,
  reason,
}: SettingsToolCardProps) {
  const roster = useQuery(agentListQueryOptions());
  const answered = botOf(output);
  const askedFor = typeof args.botId === "string" ? args.botId : undefined;
  const named = askedFor
    ? roster.data?.find((bot) => bot.id === askedFor)?.name
    : undefined;
  const title = answered?.name ?? named ?? "Your Bot";
  const asked = Object.entries(FIELD_TITLE)
    .filter(([field]) => args[field] !== undefined)
    .map(([, label]) => label);
  return (
    <SettingsChangeCard
      change={settingsChangeOf(output)}
      icon={IconRobot}
      state={state}
      title={title}
      {...(reason ? { reason } : {})}
      {...(answered && state === "done"
        ? {
            link: {
              to: `/bots/${encodeURIComponent(answered.id)}/setup`,
              label: "Open Setup",
            },
          }
        : {})}
    >
      {state === "running" && asked.length > 0 ? (
        <AskedList titles={asked} />
      ) : null}
    </SettingsChangeCard>
  );
}

/** The fields a call can change, titled as the Bot's Setup page titles them, in its order. */
const FIELD_TITLE: Record<string, string> = {
  name: "Name",
  title: "Title",
  roleDescription: "What it does",
  instructions: "Instructions",
  defaultModel: "Default model",
  visibility: "Visibility",
};
