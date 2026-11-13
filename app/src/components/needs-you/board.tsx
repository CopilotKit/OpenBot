import { IconAlertTriangle, IconChevronDown } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Fragment, type ReactNode, useState } from "react";
import { BotOrb } from "@/components/agents/bot-orb";
import { useWaitingByBot } from "@/components/approvals/waiting";
import { PageSection } from "@/components/layout/page-shell";
import { CheckInHealthFix } from "@/components/suggestions/check-in-health";
import { SuggestionRow } from "@/components/suggestions/suggestion-row";
import { TaskBoardRow } from "@/components/tasks/task-row";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { agentListQueryOptions } from "@/lib/agents/queries";
import {
  type ProactiveSetting,
  proactiveSettingsQueryOptions,
} from "@/lib/proactive";
import type { ReadFailure } from "@/lib/read-failure";
import { relativeTime } from "@/lib/relative-time";
import { useNeedsYou } from "./needs-you";

/** How many of one Bot's finds show before the rest open in place. */
const FINDS_SHOWN = 3;

/**
 * Everything waiting on the person, in three halves, each grouped under the Bot it came from.
 *
 * WAITING ON YOU is what a Bot is stopped on: a question, an action to allow or deny, a task to
 * review, answer or try again. Each is decided on its row. WORKING ON IT is a task the person started
 * that its Bot is still doing: nothing to decide yet, and it moves up when there is. FROM CHECK-INS is
 * what a Bot found on its own, which
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
  /*
   * A task its Bot is still working on waits on nobody. It sat under Waiting on you as "waiting since
   * now", counted in "1 waiting"; it has its own half now, and moves up once it is ready for review,
   * needs input or failed.
   */
  const working = new Map<string, { rows: ReactNode[]; times: string[] }>();
  for (const listed of list.tasks) {
    const groups = listed.status === "working" ? working : blocked;
    const group = groups.get(listed.task.agentId) ?? { rows: [], times: [] };
    group.rows.push(
      <TaskBoardRow key={`task-${listed.task.id}`} listed={listed} />,
    );
    group.times.push(
      listed.status === "working"
        ? listed.task.createdAt
        : listed.task.updatedAt,
    );
    groups.set(listed.task.agentId, group);
  }
  const found = new Map<string, typeof list.items>();
  for (const item of list.items)
    found.set(item.agentId, [...(found.get(item.agentId) ?? []), item]);
  /*
   * Check-ins that can't look, by Bot: each is the first row of its Bot's From check-ins, with the
   * step that fixes it. Not news, so the header's count leaves it out, as the Bots badge does.
   */
  const cantLook = new Map<string, ProactiveSetting[]>();
  for (const setting of settings.data ?? [])
    if (
      setting.enabled &&
      setting.health &&
      (agentId === undefined || setting.agentId === agentId)
    )
      cantLook.set(setting.agentId, [
        ...(cantLook.get(setting.agentId) ?? []),
        setting,
      ]);
  const checkInBots = [...new Set([...cantLook.keys(), ...found.keys()])];

  /*
   * Each read that failed, said on its own whatever else loaded. A failed read is never "nothing
   * waiting": the rows that did load stay, and the notice says which part may be missing.
   */
  const failures = [
    {
      key: "approvals",
      what: "questions and approvals",
      failure: waiting.failure,
    },
    { key: "tasks", what: "tasks", failure: list.failures.tasks },
    {
      key: "check-ins",
      what: "check-in findings",
      failure: list.failures.checkIns,
    },
  ].flatMap(({ failure, ...source }) =>
    failure ? [{ ...source, failure }] : [],
  );

  if (
    blocked.size === 0 &&
    working.size === 0 &&
    checkInBots.length === 0 &&
    failures.length === 0
  )
    return null;

  const bot = (id: string) => agents.data?.find((agent) => agent.id === id);
  const settingOf = (id: string | null | undefined) =>
    id ? settings.data?.find((setting) => setting.id === id) : undefined;
  const count = (groups: Map<string, { rows: unknown[] }>) =>
    [...groups.values()].reduce((total, group) => total + group.rows.length, 0);
  const waitingCount = count(blocked);
  const workingCount = count(working);
  const earliest = (times: string[]) =>
    times.reduce((first, at) =>
      Date.parse(at) < Date.parse(first) ? at : first,
    );
  const foundCount = list.items.length;

  return (
    <PageSection
      action={
        <span className="text-muted-foreground text-xs">
          {[
            waitingCount ? `${waitingCount} waiting` : null,
            workingCount ? `${workingCount} working` : null,
            foundCount ? `${foundCount} found` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
      }
      title="Needs you"
    >
      <div className="flex flex-col gap-5">
        {failures.length ? (
          <div className="flex flex-col gap-2">
            {failures.map(({ key, what, failure }) => (
              <ReadFailureNotice failure={failure} key={key} what={what} />
            ))}
          </div>
        ) : null}
        {blocked.size ? (
          <Half title="Waiting on you">
            {[...blocked].map(([botId, group]) => (
              <BotGroup
                bot={bot(botId)}
                botId={botId}
                key={botId}
                note={`waiting since ${relativeTime(earliest(group.times))}`}
              >
                {group.rows}
              </BotGroup>
            ))}
          </Half>
        ) : null}
        {working.size ? (
          <Half title="Working on it">
            {[...working].map(([botId, group]) => (
              <BotGroup
                bot={bot(botId)}
                botId={botId}
                key={botId}
                note={`started ${relativeTime(earliest(group.times))}`}
              >
                {group.rows}
              </BotGroup>
            ))}
          </Half>
        ) : null}
        {checkInBots.length ? (
          <Half title="From check-ins">
            {checkInBots.map((botId) => {
              const items = found.get(botId) ?? [];
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
                  cantLook={cantLook.get(botId) ?? []}
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

/** One source that didn't load: what may be missing, and Retry for that read alone. */
function ReadFailureNotice({
  what,
  failure,
}: {
  what: string;
  failure: ReadFailure;
}) {
  return (
    <div
      className="flex items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3.5 py-2.5"
      data-needs-you-failure={what}
      role="alert"
    >
      <p className="text-sm">Couldn't load {what}. Some may be missing here.</p>
      <Button
        disabled={failure.retrying}
        onClick={failure.retry}
        size="sm"
        variant="outline"
      >
        {failure.retrying ? "Retrying…" : "Retry"}
      </Button>
    </div>
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

/** One Bot's finds, the newest few with the rest a click away, after any check-in that can't look. */
function FoundGroup({
  bot,
  botId,
  note,
  items,
  cantLook,
  settingOf,
}: {
  bot: GroupBot;
  botId: string;
  note: string;
  items: ReturnType<typeof useNeedsYou>["items"];
  cantLook: ProactiveSetting[];
  settingOf: (id: string | null | undefined) => ProactiveSetting | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  const folded = expanded ? 0 : Math.max(0, items.length - FINDS_SHOWN);
  const shown = folded ? items.slice(0, FINDS_SHOWN) : items;
  const name = bot?.name ?? "Your Bot";
  const rows: ReactNode[] = cantLook.map((setting) => (
    <Item data-cant-look={setting.id} key={`cant-look-${setting.id}`} size="sm">
      <ItemMedia variant="icon">
        <IconAlertTriangle className="text-destructive" />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>
          {name} can't check {setting.subject || "your apps"}
        </ItemTitle>
        <ItemDescription className="line-clamp-none">
          {setting.health?.why}
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        <CheckInHealthFix setting={setting} />
      </ItemActions>
    </Item>
  ));
  rows.push(
    ...shown.map((item) => (
      <SuggestionRow
        botName={bot?.name ?? "Your Bot"}
        inGroup
        key={item.id}
        setting={settingOf(item.settingId)}
        suggestion={item}
      />
    )),
  );
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
