import { IconChevronDown } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Fragment, type ReactNode, useState } from "react";
import { BotOrb } from "@/components/agents/bot-orb";
import { useWaitingByBot } from "@/components/approvals/waiting";
import { PageSection } from "@/components/layout/page-shell";
import { SuggestionRow } from "@/components/suggestions/suggestion-row";
import { TaskRow } from "@/components/tasks/task-row";
import { Separator } from "@/components/ui/separator";
import { agentListQueryOptions } from "@/lib/agents/queries";
import {
  type ProactiveSetting,
  proactiveSettingsQueryOptions,
} from "@/lib/proactive";
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
 * its check-ins watch. Given a Bot (its own page), there is one group and no header.
 */
export function NeedsYouBoard({ agentId }: { agentId?: string }) {
  const agents = useQuery(agentListQueryOptions());
  const settings = useQuery(proactiveSettingsQueryOptions());
  const waiting = useWaitingByBot(agentId, agentId === undefined);
  const list = useNeedsYou(agentId);

  const blocked = new Map(waiting.byBot);
  for (const listed of list.tasks)
    blocked.set(listed.task.agentId, [
      ...(blocked.get(listed.task.agentId) ?? []),
      <TaskRow botName="" key={`task-${listed.task.id}`} listed={listed} />,
    ]);
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
    (total, rows) => total + rows.length,
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
            {[...blocked].map(([botId, rows]) => (
              <BotGroup
                bot={bot(botId)}
                botId={botId}
                header={agentId === undefined}
                key={botId}
                note={`${rows.length} waiting`}
              >
                {rows}
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
                  header={agentId === undefined}
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
      <h3 className="font-medium text-muted-foreground text-xs">{title}</h3>
      <div className="flex flex-col gap-3">{children}</div>
    </div>
  );
}

type GroupBot = { name: string; avatarSeed: string } | undefined;

/** One Bot's rows in a bordered card, opened by its orb, its name and a note on what they are. */
function BotGroup({
  bot,
  botId,
  header,
  note,
  children,
}: {
  bot: GroupBot;
  botId: string;
  header: boolean;
  note: string;
  children: ReactNode[];
}) {
  const name = bot?.name ?? "Your Bot";
  return (
    <div
      className="overflow-hidden rounded-xl border border-border"
      data-needs-you-bot={botId}
    >
      {header ? (
        <div className="flex items-center gap-2.5 border-border border-b bg-muted/50 px-3 py-2">
          <BotOrb name={name} seed={bot?.avatarSeed || botId} size={22} />
          <span className="font-medium text-sm">{name}</span>
          <span className="truncate text-muted-foreground text-xs">
            · {note}
          </span>
        </div>
      ) : null}
      <div className="flex flex-col">
        {children.map((row, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows carry their own keys inside.
          <Fragment key={index}>
            {index > 0 ? <Separator /> : null}
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
  header,
  note,
  items,
  settingOf,
}: {
  bot: GroupBot;
  botId: string;
  header: boolean;
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
      inGroup={header}
      key={item.id}
      setting={settingOf(item.settingId)}
      suggestion={item}
    />
  ));
  if (folded)
    rows.push(
      <button
        className="flex w-full items-center justify-between px-3 py-2 text-left text-muted-foreground text-sm hover:bg-muted/50"
        key="more"
        onClick={() => setExpanded(true)}
        type="button"
      >
        Show {folded} more
        <IconChevronDown className="size-4" />
      </button>,
    );
  return (
    <BotGroup bot={bot} botId={botId} header={header} note={note}>
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
