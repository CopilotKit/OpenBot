import { IconListCheck } from "@tabler/icons-react";
import { createFileRoute } from "@tanstack/react-router";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";

export const Route = createFileRoute("/_authed/_app/tasks/")({
  component: NoTaskOpen,
});

/** Beside the list, before a task is opened. A narrow screen shows the list alone instead. */
function NoTaskOpen() {
  return (
    <Empty className="flex-1">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <IconListCheck />
        </EmptyMedia>
        <EmptyTitle>No task open</EmptyTitle>
        <EmptyDescription>
          Open a task to see what its Bot did and reply to it.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
