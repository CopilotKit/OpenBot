import {
  IconBell,
  IconListCheck,
  IconSettings,
  type TablerIcon,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { agentListQueryOptions } from "@/lib/agents/queries";
import type { SettingsToolCardProps } from "./registry";
import type { SettingsScreenLink } from "./screen-link";
import { SettingsChangeCard, settingsChangeOf } from "./settings-change-card";

/**
 * `update_my_settings`, drawn: the person asked a Bot to change their own settings, and this is each
 * setting that moved, before and after, in the words of the screen it lives on.
 *
 * The rows are the server's (`changes` in the tool's output, from `personal-settings.ts`), the same
 * rows the approval card showed while it waited, so what the person allowed and what landed read
 * alike. The card opens the screen that holds what changed. Live and after a reload it is drawn from
 * the same output.
 */

type Snapshot = {
  name?: unknown;
  instructions?: unknown;
  preferences?: Record<string, unknown>;
  notifications?: { routing?: unknown; bots?: unknown };
  approvals?: unknown;
};

/** The screen the change lives on, with its title and icon, from what the call named. */
export function settingsScreenOf(after: unknown): {
  title: string;
  icon: TablerIcon;
  link: SettingsScreenLink;
} {
  const named = (after && typeof after === "object" ? after : {}) as Snapshot;
  const general =
    named.name !== undefined ||
    named.instructions !== undefined ||
    named.preferences?.skin !== undefined ||
    named.preferences?.messageListEmphasis !== undefined;
  const onlyApprovals =
    !general &&
    named.approvals !== undefined &&
    named.notifications === undefined &&
    named.preferences === undefined;
  const onlyNotifications =
    !general &&
    named.notifications?.routing !== undefined &&
    named.approvals === undefined &&
    named.preferences === undefined;
  if (onlyApprovals)
    return {
      title: "Your approvals",
      icon: IconListCheck,
      link: { to: "/settings/approvals", label: "Open Approvals" },
    };
  if (onlyNotifications)
    return {
      title: "Your notifications",
      icon: IconBell,
      link: { to: "/settings/notifications", label: "Open Notifications" },
    };
  return {
    title: "Your settings",
    icon: IconSettings,
    link: { to: "/settings", label: "Open Settings" },
  };
}

const KIND_TITLE: Record<string, string> = {
  progress: "Progress",
  decision: "Decisions",
  question: "Questions",
  attention: "Something needs you",
};

const PREFERENCE_TITLE: Record<string, string> = {
  skin: "Skin",
  messageListEmphasis: "Message list emphasis",
  proactive: "Check-ins from all your Bots",
  narration: "Narration",
};

const APPROVAL_TITLE: Record<string, string> = {
  enabled: "Extra vigilant",
  autoReview: "Auto-review",
  hostCommands: "Commands on your computer",
};

const keysOf = (value: unknown) =>
  value && typeof value === "object" ? Object.keys(value) : [];

/** The settings a call is changing, by their screens' titles, from its arguments. */
export function settingsAsked(
  args: Record<string, unknown>,
  botName: (botId: string) => string,
): string[] {
  const named = args as Snapshot;
  const titles: string[] = [];
  if (named.name !== undefined) titles.push("Name");
  if (named.instructions !== undefined) titles.push("Standing instructions");
  for (const key of keysOf(named.preferences))
    if (PREFERENCE_TITLE[key]) titles.push(PREFERENCE_TITLE[key]);
  for (const key of keysOf(named.notifications?.routing))
    if (KIND_TITLE[key]) titles.push(`Where updates go: ${KIND_TITLE[key]}`);
  const bots = named.notifications?.bots;
  if (Array.isArray(bots))
    for (const bot of bots)
      if (bot && typeof bot.botId === "string")
        titles.push(`Notifications from ${botName(bot.botId)}`);
  for (const key of keysOf(named.approvals))
    if (APPROVAL_TITLE[key]) titles.push(APPROVAL_TITLE[key]);
  return titles;
}

export function UpdateMySettingsCard({
  args,
  output,
  state,
  reason,
}: SettingsToolCardProps) {
  const roster = useQuery(agentListQueryOptions());
  const change = settingsChangeOf(output);
  const screen = settingsScreenOf(change?.after ?? args);
  const asked = settingsAsked(
    args,
    (botId) => roster.data?.find((bot) => bot.id === botId)?.name ?? "a Bot",
  );
  return (
    <SettingsChangeCard
      change={change}
      icon={screen.icon}
      state={state}
      title={screen.title}
      {...(reason ? { reason } : {})}
      {...(state === "done" ? { link: screen.link } : {})}
    >
      {state === "running" && asked.length > 0 ? (
        <AskedList titles={asked} />
      ) : null}
    </SettingsChangeCard>
  );
}

/** What a call is still changing: the settings it named, before it has an answer. */
export function AskedList({ titles }: { titles: readonly string[] }) {
  return (
    <ul className="flex flex-wrap gap-1.5" data-asked>
      {titles.map((title) => (
        <li
          className="rounded-md border border-border px-2 py-0.5 text-muted-foreground text-xs"
          key={title}
        >
          {title}
        </li>
      ))}
    </ul>
  );
}
