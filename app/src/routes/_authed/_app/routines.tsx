import { createFileRoute } from "@tanstack/react-router";
import { PageShell } from "@/components/layout/page-shell";
import { RoutinesList } from "@/components/routines/routines-list";

/**
 * A person's own standing instructions: what runs on a schedule, and a switch to stop one.
 *
 * `_authed/_app`, not Admin: a routine is something anybody has, the same way a skill is — it is
 * scoped to the signed-in person on every read and write, not to the deployment.
 *
 * THERE IS DELIBERATELY NO CREATE AND NO EDIT FORM ON THIS PAGE. Turning a sentence into a cron
 * expression and a channel is conversational work — ask a Bot in a channel, "every weekday at 9,
 * post the standup notes here" — and that is exactly what a conversation is for. This screen answers
 * a narrower question: what is standing right now, and does it stay standing. It shows and it stops;
 * it does not compose. Absent on purpose, not an omission.
 */
export const Route = createFileRoute("/_authed/_app/routines")({
  component: RoutinesPage,
});

function RoutinesPage() {
  return (
    <PageShell
      description="What a Bot does on a schedule, without being asked each time. Made and changed by talking to a Bot — this page only shows what is standing, and lets you stop one."
      title="Routines"
    >
      <RoutinesList />
    </PageShell>
  );
}
