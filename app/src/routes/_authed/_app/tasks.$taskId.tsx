import { createFileRoute } from "@tanstack/react-router";
import { TaskPage } from "@/components/tasks/task-page";

export const Route = createFileRoute("/_authed/_app/tasks/$taskId")({
  component: RouteComponent,
});

function RouteComponent() {
  const { taskId } = Route.useParams();
  // Remounted for each task, so one task's conversation never carries into the next.
  return <TaskPage key={taskId} taskId={taskId} />;
}
