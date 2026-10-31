import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { TaskPage } from "@/components/tasks/task-page";

const taskSearchSchema = z.object({
  /** Opens the Bot's computer beside the task. */
  watch: z.boolean().optional(),
});

export const Route = createFileRoute("/_authed/_app/tasks/$taskId")({
  validateSearch: taskSearchSchema,
  component: RouteComponent,
});

function RouteComponent() {
  const { taskId } = Route.useParams();
  const { watch } = Route.useSearch();
  const navigate = Route.useNavigate();
  // Remounted for each task, so one task's conversation never carries into the next.
  return (
    <TaskPage
      key={taskId}
      onWatchChange={(open) =>
        navigate({
          search: (previous) => ({
            ...previous,
            watch: open ? true : undefined,
          }),
        })
      }
      taskId={taskId}
      watching={watch === true}
    />
  );
}
