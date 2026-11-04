import { IconChevronDown } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Fragment, type ReactNode, useState } from "react";
import { BotOrb } from "@/components/agents/bot-orb";
import { useWaitingByBot } from "@/components/approvals/waiting";
import { PageSection } from "@/components/layout/page-shell";
import { SuggestionRow } from "@/components/suggestions/suggestion-row";
import { TaskBoardRow } from "@/components/tasks/task-row";
import { Separator } from "@/components/ui/separator";
import { agentListQueryOptions } from "@/lib/agents/queries";
import {
  type ProactiveSetting,
  proactiveSettingsQueryOptions,
} from "@/lib/proactive";
import { relativeTime } from "@/lib/relative-time";
import { useNeedsYou } from "./needs-you";

/** How many of one Bot's finds show before the rest open in place. */
const FINDS_SHOWN = 3;

/**
 * Everything waiting on the person, in two halves, each grouped under the Bot it came from.
 *
 * WAITING ON YOU is what a Bot is stopped on: a question, an action to allow or deny, a task to
 * review or answer. Each is decided on its row. FROM CHECK-INS is what a Bot found on its own, which
 * the person may act on or not; it is quieter, and the Bots badge does not count it
 * (`waitingOnYou`).
 *
 * BOT FIRST. A row used to name its Bot in the faintest line at its foot, and with two Bots nobody
 * could tell who was asking. Each group now opens with the Bot's orb and name, and for finds, what
 * its check-ins watch. Given a Bot (its own page), there is one group of each.
 */
export function NeedsYouBoard({ agentId }: { agentId?: string }) {
  const agents = useQuery(agentListQueryOptions());
  const settings = useQuery(proactiveSettingsQueryOptions());
  const waiting = useWaitingByBot(agentId);
  const list = useNeedsYou(agentId);

  const blocked = new Map(waiting.byBot);
  for (const listed of list.tasks) {
    const group = blocked.get(listed.task.agentId) ?? { rows: [], times: [] };
    group.rows.push(
      <TaskBoardRow key={`task-${listed.task.id}`} listed={listed} />,
    );
    group.times.push(listed.task.updatedAt);
    blocked.set(listed.task.agentId, group);
  }
  const found = new Map<string, typeof list.items>();
  for (const item of list.items)
    found.set(item.agentId, [...(found.get(item.agentId) ?? []), item]);

  if (blocked.size === 0 && found.size === 0) {
    const error = waiting.error ?? list.error;
    return error ? (
      <PageSection title="Needs you">
        <p className="mt-4 text-destructive text-sm" role="alert">
          {error.message}
        </p>
      </PageSection>
    ) : null;
  }

  const bot = (id: string) => agents.data?.find((agent) => agent.id === id);
  const settingOf = (id: string | null | undefined) =>
    id ? settings.data?.find((setting) => setting.id === id) : undefined;
  const waitingCount = [...blocked.values()].reduce(
    (total, group) => total + group.rows.length,
    0,
  );
  const foundCount = list.items.length;

  return (
    <PageSection
      action={
        <span className="text-muted-foreground text-xs">
          {[
            waitingCount ? `${waitingCount} waiting` : null,
            foundCount ? `${foundCount} found` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
      }
      title="Needs you"
    >
      <div className="flex flex-col gap-5">
        {blocked.size ? (
          <Half title="Waiting on you">
            {[...blocked].map(([botId, group]) => (
              <BotGroup
                bot={bot(botId)}
                botId={botId}
                key={botId}
                note={`waiting since ${relativeTime(
                  group.times.reduce((first, at) =>
                    Date.parse(at) < Date.parse(first) ? at : first,
                  ),
                )}`}
              >
                {group.rows}
              </BotGroup>
            ))}
          </Half>
        ) : null}
        {found.size ? (
          <Half title="From check-ins">
            {[...found].map(([botId, items]) => {
              const watched = [
                ...new Set(
                  items
                    .map((item) => settingOf(item.settingId)?.subject)
                    .filter((subject): subject is string => Boolean(subject)),
                ),
              ];
              return (
                <FoundGroup
                  bot={bot(botId)}
                  botId={botId}
                  items={items}
                  key={botId}
                  note={
                    watched.length
                      ? `watching ${watched.join(", ")}`
                      : "from its check-ins"
                  }
                  settingOf={settingOf}
                />
              );
            })}
          </Half>
        ) : null}
      </div>
    </PageSection>
  );
}

function Half({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="font-semibold text-muted-foreground text-xs">{title}</h3>
      <div className="flex flex-col gap-3">{children}</div>
    </div>
  );
}

type GroupBot = { name: string; avatarSeed: string } | undefined;

/** One Bot's rows in a bordered card, opened by its orb, its name and a note on what they are. */
function BotGroup({
  bot,
  botId,
  note,
  children,
}: {
  bot: GroupBot;
  botId: string;
  note: string;
  children: ReactNode[];
}) {
  const name = bot?.name ?? "Your Bot";
  return (
    <div
      // The page's own card: white on the off-white page, borderless in the dark, as PageRows is.
      className="overflow-hidden rounded-lg border border-border bg-card dark:border-transparent"
      data-needs-you-bot={botId}
    >
      <div className="flex items-center gap-2.5 border-border border-b bg-muted px-3.5 py-2.5">
        <BotOrb name={name} seed={bot?.avatarSeed || botId} size={22} />
        <span className="font-semibold text-[13px]">{name}</span>
        <span className="truncate text-muted-foreground text-xs">· {note}</span>
      </div>
      <div className="flex flex-col">
        {children.map((row, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows carry their own keys inside.
          <Fragment key={index}>
            {/* Short of each edge, lined up with the rows' text, as PageRows draws them. */}
            {index > 0 ? <Separator className="mx-4 w-auto" /> : null}
            {row}
          </Fragment>
        ))}
      </div>
    </div>
  );
}

/** One Bot's finds, the newest few with the rest a click away. */
function FoundGroup({
  bot,
  botId,
  note,
  items,
  settingOf,
}: {
  bot: GroupBot;
  botId: string;
  note: string;
  items: ReturnType<typeof useNeedsYou>["items"];
  settingOf: (id: string | null | undefined) => ProactiveSetting | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  const folded = expanded ? 0 : Math.max(0, items.length - FINDS_SHOWN);
  const shown = folded ? items.slice(0, FINDS_SHOWN) : items;
  const rows: ReactNode[] = shown.map((item) => (
    <SuggestionRow
      botName={bot?.name ?? "Your Bot"}
      inGroup
      key={item.id}
      setting={settingOf(item.settingId)}
      suggestion={item}
    />
  ));
  if (folded)
    rows.push(
      <button
        className="flex w-full items-center justify-between px-3.5 py-2.5 text-left text-muted-foreground text-[13px] hover:bg-muted"
        key="more"
        onClick={() => setExpanded(true)}
        type="button"
      >
        Show {folded} more
        <IconChevronDown className="size-4" />
      </button>,
    );
  return (
    <BotGroup bot={bot} botId={botId} note={note}>
      {rows}
    </BotGroup>
  );
}

/**
 * What one Bot is waiting on the person for, at the top of its page: the same board, for one Bot.
 * Nothing is drawn when nothing waits.
 */
export function BotNeedsYou({ agentId }: { agentId: string }) {
  return <NeedsYouBoard agentId={agentId} />;
}
