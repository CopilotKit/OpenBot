import { IconX } from "@tabler/icons-react";
import { useMutation } from "@tanstack/react-query";
import { useSwitchOrganization } from "@/components/organizations/use-switch-organization";
import { Button } from "@/components/ui/button";
import { movedElsewhereSaid } from "@/lib/moves/moved-elsewhere";
import { MoveStopped, moveHereMutationOptions } from "@/lib/moves/mutations";
import { useMovedElsewhere } from "@/lib/moves/use-moved-elsewhere";
import {
  dismissNoticeMutationOptions,
  useUserPreferences,
} from "@/lib/settings/message-list";
import { queryClient } from "@/query-client";

/**
 * A slim bar, beside the plan and update bars, when the person's moved Bots are in another of their
 * organizations than the one they work in: which one, Switch to work there, Move them here, and
 * Dismiss for somebody who works where they are on purpose. Drawn as the self-host bar is.
 *
 * OpenBot Desktop moves everything into one of the person's organizations, and a browser can sign in
 * working in another of theirs, such as their company's. There they find none of their Bots, and
 * without this nothing says where they are, or lets them bring them across.
 *
 * Move them here is offered unless the organization they work in doesn't let them use Bots
 * (Organization.canMoveIn), which is said in its place. Once moved, everything is read again and the
 * bar goes by its own rule: the newest move is now here.
 */
export function MovedElsewhereBanner() {
  const moved = useMovedElsewhere();
  const switching = useSwitchOrganization();
  const { userId } = useUserPreferences();
  const dismiss = useMutation(
    dismissNoticeMutationOptions(queryClient, userId),
  );
  const moving = useMutation(moveHereMutationOptions(queryClient));
  if (!moved) return null;
  const moveHere = () =>
    moving.mutate({
      fromOrganizationId: moved.organizationId,
      ...(moving.error instanceof MoveStopped
        ? { importId: moving.error.importId }
        : {}),
    });
  return (
    <aside
      aria-label="Your moved Bots"
      className="flex shrink-0 flex-wrap items-center gap-x-2 border-b border-border bg-muted/60 px-4 py-1.5 text-sm"
    >
      <p className="text-foreground">{movedElsewhereSaid(moved)}</p>
      {moving.error ? (
        <p className="text-destructive" role="alert">
          {moving.error.message}
        </p>
      ) : null}
      <span className="flex items-center gap-2">
        <Button
          // Foreground, not the link variant's primary, which is a mid grey on the dark bar.
          className="px-0 text-foreground underline"
          disabled={switching.pending || moving.isPending}
          onClick={() => switching.run(moved.organizationId)}
          size="sm"
          variant="link"
        >
          Switch to {moved.organizationName}
        </Button>
        {moved.here.canMoveIn ? (
          <Button
            className="px-0 text-foreground underline"
            disabled={moving.isPending || switching.pending}
            onClick={moveHere}
            size="sm"
            variant="link"
          >
            {moving.isPending
              ? `Moving them to ${moved.here.name}…`
              : moving.isError
                ? "Try again"
                : `Move them to ${moved.here.name}`}
          </Button>
        ) : (
          <span className="text-muted-foreground">
            You can't move them to {moved.here.name}. Ask an admin to let you
            use Bots there.
          </span>
        )}
        <Button
          aria-label="Dismiss"
          disabled={dismiss.isPending || moving.isPending}
          onClick={() => dismiss.mutate(moved.noticeId)}
          size="icon-xs"
          variant="ghost"
        >
          <IconX />
        </Button>
      </span>
    </aside>
  );
}
