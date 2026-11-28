import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AnimatePresence } from "motion/react";
import { PageRows, PageSection } from "@/components/layout/page-shell";
import { GroupRow } from "@/components/routines/bot-group";
import { Unfold } from "@/components/routines/unfold";
import { Button } from "@/components/ui/button";
import { loadFailure } from "@/lib/load-failure";
import { proactiveSettingsQueryOptions } from "@/lib/proactive";
import { responsibilitiesQueryOptions } from "@/lib/responsibilities";
import { runningAndScheduled } from "@/lib/routines/by-bot";
import { mergeRoutines } from "@/lib/routines/merged";
import { routinesQueryOptions } from "@/lib/routines/queries";

/** How many rows the Bot's page shows before See all. */
const SHOWN = 5;

/**
 * A Bot's routines on its own page, under For you: what is running now and what is lined up next,
 * as the Routines page draws them, with See all to the Bot's Routines. Not drawn for a Bot with no
 * routines, which its Routines row under Settings already says.
 */
export function BotRoutinesSummary({ agentId }: { agentId: string }) {
  const routines = useQuery(routinesQueryOptions());
  const goals = useQuery(responsibilitiesQueryOptions());
  const checkIns = useQuery(proactiveSettingsQueryOptions());
  if (routines.isPending || goals.isPending || checkIns.isPending) return null;

  const all = mergeRoutines({
    routines: routines.data?.routines ?? [],
    goals: goals.data ?? [],
    checkIns: checkIns.data ?? [],
  }).filter((row) => row.agentId === agentId);
  const failed = [routines.error, goals.error, checkIns.error].find(Boolean);
  if (all.length === 0 && !failed) return null;
  const shown = runningAndScheduled(all, agentId).slice(0, SHOWN);

  return (
    <PageSection
      action={
        <Button
          render={<Link params={{ agentId }} to="/bots/$agentId/routines" />}
          size="sm"
          variant="ghost"
        >
          See all
        </Button>
      }
      title="Routines"
    >
      {/* One read failing leaves the others listed, and says so. */}
      {failed ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {loadFailure(
            failed,
            "Couldn't load all of this Bot's routines. Try again in a moment.",
          )}
        </p>
      ) : null}
      {shown.length > 0 ? (
        <PageRows className="p-1.5">
          <AnimatePresence initial={false}>
            {shown.map((row) => (
              <Unfold key={`${row.kind}:${row.id}`}>
                <GroupRow row={row} />
              </Unfold>
            ))}
          </AnimatePresence>
        </PageRows>
      ) : failed ? null : (
        <p className="mt-4 text-muted-foreground text-sm">
          Nothing running or scheduled.
        </p>
      )}
    </PageSection>
  );
}
