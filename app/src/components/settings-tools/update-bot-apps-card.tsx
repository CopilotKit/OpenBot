import { appToolName, connectorName } from "@openbot/shared/tool-name";
import { IconRobot } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { PluginLogo } from "@/components/plugins/plugin-logo";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { useDeclaredBotId } from "@/lib/copilot/active-bot";
import type { SettingsToolCardProps } from "./registry";
import { SettingsChangeCard, settingsChangeOf } from "./settings-change-card";
import { AskedList } from "./update-my-settings-card";

/**
 * `update_bot_apps`, drawn: the person asked a Bot to change what one of their Bots can use in an
 * app, and this is the app, then each action that moved, before and after, as the Bot's Apps page
 * says it.
 *
 * The rows are the server's (`changes` in the tool's output), the same rows the approval card
 * showed. The card is titled with the Bot's name, shows the app by its logo and name, and opens the
 * Bot's Apps page. Before it has an answer, the Bot is the one the call names, or the Bot making it
 * when it names none, and the app and actions are the ones the call asks for.
 */

type Output = {
  bot?: { id?: unknown; name?: unknown };
  app?: { id?: unknown; title?: unknown; logo?: unknown };
};

/** The Bot the answer names, as `{ id, name }`, or nothing when it names none. */
function botOf(output: Record<string, unknown> | null) {
  const bot = (output as Output | null)?.bot;
  return bot && typeof bot.id === "string" && typeof bot.name === "string"
    ? { id: bot.id, name: bot.name }
    : null;
}

/** The app the answer names, as `{ title, logo }`, or nothing when it names none. */
function appOf(output: Record<string, unknown> | null) {
  const app = (output as Output | null)?.app;
  return app && typeof app.title === "string"
    ? {
        title: app.title,
        logo: typeof app.logo === "string" ? app.logo : null,
      }
    : null;
}

/**
 * The Bot a call is about, by name, before it has an answer: the one it names, by its id or by its
 * name as the server reads it, or the Bot in this conversation when it names none.
 *
 * FOUND IN DOGFOODING. Talking with a shared Bot that wasn't his, a person saw "Your Bot" on every
 * refused call, about a Bot that wasn't his and that he had none of: the call named the Bot by its
 * name, or named none, and only an id was looked up.
 */
export function botNamed(
  roster: readonly { id: string; name: string }[] | undefined,
  botId: unknown,
  declared: string | undefined,
): string | undefined {
  const plain = (name: string) =>
    name
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ")
      .replace(/^the /, "")
      .replace(/ bot$/, "");
  const asked =
    typeof botId === "string" && botId.trim() ? botId.trim() : declared;
  if (!asked) return undefined;
  const byId = roster?.find((bot) => bot.id === asked);
  if (byId) return byId.name;
  const byName = roster?.filter((bot) => plain(bot.name) === plain(asked));
  return byName?.length === 1 ? byName[0]?.name : undefined;
}

/** An action by its ref (`gmail/GMAIL_SEND_EMAIL`), as the app's page names it: "Send email". */
export function actionName(ref: string): string {
  const slash = ref.indexOf("/");
  return slash > 0
    ? appToolName(ref.slice(0, slash), ref.slice(slash + 1)).label
    : appToolName("", ref).label;
}

const refs = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((ref): ref is string => typeof ref === "string" && !!ref)
    : [];

/** What a call is asking for, before it has an answer, in the words its rows will use. */
export function botAppsAsked(
  args: Record<string, unknown>,
  app: string,
): string[] {
  const asked: string[] = [];
  for (const ref of refs(args.give)) asked.push(`${actionName(ref)}: On`);
  if (typeof args.need === "string" && args.need.trim()) {
    const need = args.need.trim();
    asked.push(need.charAt(0).toUpperCase() + need.slice(1));
  }
  for (const ref of refs(args.takeAway)) asked.push(`${actionName(ref)}: Off`);
  if (args.takeAwayApp === true) asked.push(`${app}: Can't use`);
  return asked;
}

/** The app the rows are in: its logo and its name, as the Bot's Apps page draws it. */
function AppLine({ title, logo }: { title: string; logo: string | null }) {
  return (
    <div className="flex items-center gap-2.5" data-app={title}>
      <div className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-background">
        <PluginLogo logo={logo} name={title} />
      </div>
      <span className="min-w-0 truncate font-medium text-sm">{title}</span>
    </div>
  );
}

export function UpdateBotAppsCard({
  args,
  output,
  state,
  reason,
}: SettingsToolCardProps) {
  const roster = useQuery(agentListQueryOptions());
  const declared = useDeclaredBotId();
  const answered = botOf(output);
  const title =
    answered?.name ?? botNamed(roster.data, args.botId, declared) ?? "This Bot";
  const app = appOf(output) ?? {
    title:
      typeof args.app === "string" && args.app.trim()
        ? connectorName(args.app.trim())
        : "",
    logo: null,
  };
  const asked = botAppsAsked(args, app.title || "The app");
  return (
    <SettingsChangeCard
      change={settingsChangeOf(output)}
      icon={IconRobot}
      state={state}
      title={title}
      {...(reason ? { reason } : {})}
      {...(app.title ? { lead: <AppLine {...app} /> } : {})}
      {...(answered && state === "done"
        ? {
            link: {
              to: `/bots/${encodeURIComponent(answered.id)}/apps`,
              label: "Open Apps",
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
