import { createFileRoute } from "@tanstack/react-router";
import { PageShell } from "@/components/layout/page-shell";
import { NewRoutineButton } from "@/components/routines/new-routine-button";
import { RoutinesList } from "@/components/routines/routines-list";

/**
 * Every routine the person has, across all their Bots: one place to find scheduled work and to set
 * some up, as the Scheduled section of other assistants is. In the sidebar beside Bots and
 * Connections.
 *
 * `_authed/_app`, not Admin: a routine is something anybody has, the same way a skill is. It is
 * scoped to the signed-in person on every read and write, not to the deployment.
 *
 * New routine opens its own screen (`routines_.new.tsx`) with a picker of common schedules. Asking
 * a Bot in a conversation still works for anything the picker does not cover, and changing a
 * routine stays conversational: this page has no edit form.
 */
export const Route = createFileRoute("/_authed/_app/routines")({
  component: RoutinesPage,
});

function RoutinesPage() {
  return (
    <PageShell
      action={<NewRoutineButton />}
      description="Bots do work for you on a schedule and post what they did. Set one up here, or ask a Bot something like “every weekday at 9, send me…”."
      title="Routines"
    >
      <RoutinesList />
    </PageShell>
  );
}
