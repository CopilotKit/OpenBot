import { createFileRoute } from "@tanstack/react-router";
import { PageShell } from "@/components/layout/page-shell";
import { NewRoutineButton } from "@/components/routines/new-routine-button";
import { RoutinesList } from "@/components/routines/routines-list";
import { CheckInsSection } from "@/components/settings/check-ins";

/**
 * Every Bot's routines on one page: its routines, its goals and its check-ins, as one list. The
 * every-Bot scope of Routines; each Bot's own are on its page (`bots.$agentId.routines.tsx`).
 *
 * Under Settings, not Admin: a routine is something anybody has, scoped to the signed-in person on
 * every read and write. The switch for every Bot's check-ins at once sits under the list.
 */
export const Route = createFileRoute("/_authed/settings/routines")({
  component: RoutinesPage,
});

function RoutinesPage() {
  return (
    <PageShell
      action={<NewRoutineButton />}
      description="Your Bots work on their own: on a schedule, toward a goal, or by checking in when something changes. Ask a Bot to set one up, or use New routine."
      title="Routines"
    >
      <RoutinesList />
      <CheckInsSection />
    </PageShell>
  );
}
