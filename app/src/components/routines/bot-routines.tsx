import { IconChevronRight, IconClock } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Fragment } from "react";
import { usePausedAll } from "@/components/bots/paused-all";
import { PageRows, PageSection } from "@/components/layout/page-shell";
import {
  SettingRow,
  useCheckInsBlocked,
} from "@/components/suggestions/proactive-panel";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import {
  botActivityQueryOptions,
  botLifecycleQueryOptions,
} from "@/lib/bot-lifecycle/queries";
import { proactiveSettingsQueryOptions } from "@/lib/proactive";
import { responsibilitiesQueryOptions } from "@/lib/responsibilities";
import {
  countRoutines,
  type OnRoutine,
  routineCountsLine,
  routinesOn,
} from "@/lib/routines/bot-routines";
import { mergeRoutines } from "@/lib/routines/merged";
import { routinesQueryOptions } from "@/lib/routines/queries";
import { GoalItem, RoutineItem } from "./routines-list";

/** How many of a Bot's routines its page lists before All routines. */
const SHOWN = 5;

/**
 * One Bot's routines, goals and check-ins, from the three reads the Routines page makes and the
 * Bot's activity: every row (`rows`, on and off, as its Routines page lists them) and the ones that
 * are on, ordered and counted (`on`, `counts`). The Bot's page and a conversation's clock both read
 * this, so they never disagree.
 */
export function useBotRoutines(agentId: string | undefined) {
  const routines = useQuery(routinesQueryOptions());
  const goals = useQuery(responsibilitiesQueryOptions());
  const checkIns = useQuery(proactiveSettingsQueryOptions());
  const activity = useQuery({
    ...botActivityQueryOptions(agentId ?? ""),
    enabled: Boolean(agentId),
  });
  const rows = agentId
    ? mergeRoutines({
        routines: routines.data?.routines ?? [],
        goals: goals.data ?? [],
        checkIns: checkIns.data ?? [],
        agentId,
      })
    : [];
  const on = routinesOn(rows, activity.data);
  return {
    pending: routines.isPending || goals.isPending || checkIns.isPending,
    /** Undefined when the routines read failed, so a goal's starts are not claimed. */
    routinesRead: routines.error ? undefined : routines.data,
    rows,
    on,
    counts: countRoutines(on),
    /** Whether one of those on can't look or failed last time. */
    needsLook: on.some((row) => row.needsLook),
  };
}

/** Whether this Bot is paused, by itself or with all. */
export function useBotPaused(agentId: string | undefined) {
  const lifecycle = useQuery({
    ...botLifecycleQueryOptions(agentId ?? ""),
    enabled: Boolean(agentId),
  });
  return usePausedAll() || lifecycle.data?.paused === true;
}

/**
 * One of a Bot's routines, drawn by the Routines page's own row for its kind, so the two can never
 * say different things. Each opens that routine's own page, which goes back to `back`.
 */
export function BotRoutineRow({
  on,
  agentId,
  paused,
  blocked,
  botName,
  routinesRead,
}: {
  on: Pick<OnRoutine, "row" | "running">;
  agentId: string;
  paused: boolean;
  blocked: string | null;
  botName: string;
  routinesRead: unknown;
}) {
  const { row, running } = on;
  if (row.kind === "routine")
    return (
      <RoutineItem
        agentId={agentId}
        paused={paused}
        routine={row.routine}
        running={running}
      />
    );
  if (row.kind === "goal")
    return (
      <GoalItem
        agentId={agentId}
        goal={row.goal}
        paused={paused}
        routines={routinesRead ? row.routines : undefined}
        running={running}
      />
    );
  return (
    <SettingRow
      agentId={agentId}
      blocked={paused ? "Paused" : blocked}
      botName={botName}
      label="Check-in"
      running={running}
      setting={row.checkIn}
      showBot={false}
    />
  );
}

/**
 * What a Bot does by itself, on its page between For you and Activity: each routine, goal and
 * check-in that is on, when it starts next and how its last run went, without opening anything.
 *
 * The rows are the Routines page's rows, from the same merged list, so the two never disagree.
 * Running now first, then the ones that need a look, then by what starts next, then the goals that
 * wait to be asked; at most five, then All routines, which is always the last row. Not drawn for a
 * Bot with nothing on: the Routines row under its settings says so.
 */
export function BotRoutinesSection({
  agentId,
  botName,
}: {
  agentId: string;
  botName: string;
}) {
  const { pending, rows, on, counts, routinesRead } = useBotRoutines(agentId);
  const paused = useBotPaused(agentId);
  const blocked = useCheckInsBlocked();
  if (pending || on.length === 0) return null;
  return (
    <PageSection
      action={
        <span className="text-muted-foreground text-xs">
          {routineCountsLine(counts)}
        </span>
      }
      title="Routines"
    >
      <PageRows>
        {on.slice(0, SHOWN).map((routine) => (
          <Fragment key={`${routine.row.kind}:${routine.row.id}`}>
            <BotRoutineRow
              agentId={agentId}
              blocked={blocked}
              botName={botName}
              on={routine}
              paused={paused}
              routinesRead={routinesRead}
            />
            <Separator />
          </Fragment>
        ))}
        <Item
          render={<Link params={{ agentId }} to="/bots/$agentId/routines" />}
          size="sm"
        >
          <ItemMedia variant="icon">
            <IconClock />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>All routines</ItemTitle>
          </ItemContent>
          <ItemActions>
            <ItemDescription>{rows.length} in all</ItemDescription>
            <IconChevronRight className="size-4 text-muted-foreground" />
          </ItemActions>
        </Item>
      </PageRows>
    </PageSection>
  );
}
