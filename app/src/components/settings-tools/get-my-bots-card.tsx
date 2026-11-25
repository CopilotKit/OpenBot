import {
  IconChevronRight,
  IconLock,
  IconRobot,
  IconUsers,
} from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import { Badge } from "@/components/gallery/frame";
import type { SettingsToolCardProps } from "./registry";
import { SettingsReadCard } from "./settings-read-card";

/**
 * `get_my_bots`: the Bots the person can see, as the Bots page lists them, each with its title, who
 * can use it and its default model, opening that Bot's Setup.
 */

type Bot = {
  id?: string;
  name?: string;
  title?: string;
  description?: string;
  avatarSeed?: string;
  visibility?: string;
  mine?: boolean;
  canChange?: boolean;
  defaultModel?: {
    id?: string;
    label?: string | null;
    effort?: string | null;
  } | null;
};

/** A model as the Setup page names it: "Claude Sonnet 4.5 · High". */
function modelName(model: NonNullable<Bot["defaultModel"]>): string {
  const name = model.label || model.id || "";
  const effort = model.effort
    ? model.effort.charAt(0).toUpperCase() + model.effort.slice(1)
    : null;
  return effort ? `${name} · ${effort}` : name;
}

export function GetMyBotsCard({
  output,
  state,
  reason,
}: SettingsToolCardProps) {
  const bots = ((output?.bots as Bot[] | undefined) ?? []).filter(
    (bot): bot is Bot & { id: string; name: string } =>
      typeof bot.id === "string" && typeof bot.name === "string",
  );
  const total = typeof output?.total === "number" ? output.total : bots.length;
  const yours = bots.filter((bot) => bot.mine).length;
  return (
    <SettingsReadCard
      caption={
        total === 0
          ? "You don't have any Bots yet."
          : `${total} ${total === 1 ? "Bot" : "Bots"}, ${yours} of them yours.`
      }
      icon={IconRobot}
      link={{ to: "/bots", label: "Open Bots" }}
      state={state}
      title="Your Bots"
      {...(reason ? { reason } : {})}
    >
      {bots.length > 0 ? (
        <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-lg border border-border">
          {bots.map((bot) => (
            <li data-bot={bot.id} key={bot.id}>
              <Link
                className="flex items-start gap-3 px-3 py-2.5 transition-colors hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-ring motion-reduce:transition-none"
                params={{ agentId: bot.id }}
                to="/bots/$agentId/setup"
              >
                <AbstractAvatar
                  name={bot.name}
                  seed={bot.avatarSeed || bot.id}
                  size={32}
                />
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="truncate font-medium text-sm">
                      {bot.name}
                    </span>
                    {bot.visibility === "public" ? (
                      <Badge>
                        <IconUsers aria-hidden className="mr-1 size-3" />
                        Public
                      </Badge>
                    ) : (
                      <Badge>
                        <IconLock aria-hidden className="mr-1 size-3" />
                        Private
                      </Badge>
                    )}
                    {!bot.canChange ? (
                      <Badge tone="caution">View only</Badge>
                    ) : null}
                  </span>
                  {bot.title || bot.description ? (
                    <span className="line-clamp-2 text-muted-foreground text-xs">
                      {bot.title || bot.description}
                    </span>
                  ) : null}
                  {bot.defaultModel ? (
                    <span
                      className="truncate text-muted-foreground text-xs"
                      data-model
                    >
                      {modelName(bot.defaultModel)}
                    </span>
                  ) : null}
                </span>
                <IconChevronRight
                  aria-hidden
                  className="size-4 shrink-0 self-center text-muted-foreground"
                />
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
      {total > bots.length ? (
        <p className="text-muted-foreground text-xs">
          And {total - bots.length} more on the Bots page.
        </p>
      ) : null}
    </SettingsReadCard>
  );
}
