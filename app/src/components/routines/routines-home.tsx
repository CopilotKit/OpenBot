import { useQuery } from "@tanstack/react-query";
import { AnimatePresence } from "motion/react";
import { LoadingRows } from "@/components/layout/loading-rows";
import { PageColumn } from "@/components/layout/page-parts";
import {
  SidebarToggle,
  useSidebarToggleVisible,
} from "@/components/layout/sidebar-toggle";
import { BotGroupSection } from "@/components/routines/bot-group";
import { RoutineBox } from "@/components/routines/routine-box";
import { Unfold } from "@/components/routines/unfold";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { loadFailure } from "@/lib/load-failure";
import { proactiveSettingsQueryOptions } from "@/lib/proactive";
import { responsibilitiesQueryOptions } from "@/lib/responsibilities";
import { routinesByBot } from "@/lib/routines/by-bot";
import { mergeRoutines } from "@/lib/routines/merged";
import { routinesQueryOptions } from "@/lib/routines/queries";

/** What a page with nothing on it offers to fill the box with: pressing one only types it. */
const EXAMPLES = [
  "Every weekday at 9, send me yesterday's new leads",
  "Every Friday at 4, summarize what changed in my projects this week",
  "Keep an eye on my inbox and tell me when a customer writes",
] as const;

/**
 * The Routines page: one box that makes a routine from a sentence, then every routine the person
 * has grouped by Bot. The switch for every Bot's check-ins is in Settings → Notifications.
 *
 * Reads what `RoutinesList` reads (routines, goals, check-ins, and the shown and hidden Bots for
 * the groups), so each row opens and changes its own record the way it always did. It draws its
 * own bar and column rather than `PageShell`: the page has no title row and no New routine button,
 * its heading is part of what it says.
 */
export function RoutinesHome() {
  const showToggle = useSidebarToggleVisible();
  const routines = useQuery(routinesQueryOptions());
  const goals = useQuery(responsibilitiesQueryOptions());
  const checkIns = useQuery(proactiveSettingsQueryOptions());
  const shownBots = useQuery(agentListQueryOptions());
  const hiddenBots = useQuery(agentListQueryOptions(true));

  const rows = mergeRoutines({
    routines: routines.data?.routines ?? [],
    goals: goals.data ?? [],
    checkIns: checkIns.data ?? [],
  });
  const groups = routinesByBot(
    rows,
    shownBots.data ?? [],
    hiddenBots.data ?? [],
  );
  // The Bots are waited for too: a row whose Bot is not read yet would be drawn under "A Bot".
  const pending =
    routines.isPending ||
    goals.isPending ||
    checkIns.isPending ||
    shownBots.isPending ||
    hiddenBots.isPending;
  const failed = [
    routines.error ? "routines" : null,
    goals.error ? "goals" : null,
    checkIns.error ? "check-ins" : null,
    shownBots.error || hiddenBots.error ? "Bots" : null,
  ].filter((name): name is string => name !== null);
  const empty = !pending && failed.length === 0 && rows.length === 0;

  return (
    <>
      {showToggle ? (
        <div className="flex h-14 w-full max-w-7xl items-center gap-1 px-3">
          <SidebarToggle />
        </div>
      ) : null}
      <PageColumn bar={showToggle}>
        <div className="pt-4 pb-6 text-center">
          <h1 className="font-semibold text-3xl leading-tight tracking-tight">
            Give your Bots some work
          </h1>
          <p className="mt-3 text-muted-foreground text-sm">
            Routines run on a schedule, towards a goal or wake up the Bot if
            they expect something from the outside.
          </p>
        </div>

        <RoutineBox
          bots={shownBots.data}
          examples={empty ? EXAMPLES : undefined}
        />

        {/* Inset from the box's edges, so the list reads as under it rather than as wide as it. */}
        <div className="mt-8 px-3 sm:px-4">
          {/* One read failing leaves the others listed, and says which part is missing. */}
          {failed.length > 0 ? (
            <p className="mb-4 text-destructive text-sm" role="alert">
              {loadFailure(
                [
                  routines.error,
                  goals.error,
                  checkIns.error,
                  shownBots.error,
                  hiddenBots.error,
                ],
                `Couldn't load your ${failed.join(" and ")}. Try again in a moment.`,
              )}
            </p>
          ) : null}
          {/* Pending draws the list's shape; rows already read stay while they refetch. */}
          {pending ? (
            <LoadingRows label="Loading your routines" />
          ) : (
            // A Bot's first routine opens its group; its last one removed folds it away.
            <AnimatePresence initial={false}>
              {groups.map((group) => (
                <Unfold key={group.botId}>
                  <BotGroupSection group={group} />
                </Unfold>
              ))}
            </AnimatePresence>
          )}
        </div>
      </PageColumn>
    </>
  );
}
