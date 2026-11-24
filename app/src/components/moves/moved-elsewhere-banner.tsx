import { IconX } from "@tabler/icons-react";
import { useMutation } from "@tanstack/react-query";
import { useSwitchOrganization } from "@/components/organizations/use-switch-organization";
import { Button } from "@/components/ui/button";
import { movedElsewhereSaid } from "@/lib/moves/moved-elsewhere";
import { useMovedElsewhere } from "@/lib/moves/use-moved-elsewhere";
import {
  dismissNoticeMutationOptions,
  useUserPreferences,
} from "@/lib/settings/message-list";
import { queryClient } from "@/query-client";

/**
 * A slim bar, beside the plan and update bars, when the person's moved Bots are in another of their
 * organizations than the one they work in: which one, Switch to work there, and Dismiss for somebody
 * who works where they are on purpose. Drawn as the self-host bar is.
 *
 * OpenBot Desktop moves everything into the person's own organization, and a browser can sign in
 * working in another of theirs, such as their company's. There they find none of their Bots, and
 * without this nothing says where they are.
 */
export function MovedElsewhereBanner() {
  const moved = useMovedElsewhere();
  const switching = useSwitchOrganization();
  const { userId } = useUserPreferences();
  const dismiss = useMutation(
    dismissNoticeMutationOptions(queryClient, userId),
  );
  if (!moved) return null;
  return (
    <aside
      aria-label="Your moved Bots"
      className="flex shrink-0 flex-wrap items-center gap-x-2 border-b border-border bg-muted/60 px-4 py-1.5 text-sm"
    >
      <p className="text-foreground">{movedElsewhereSaid(moved)}</p>
      <span className="flex items-center gap-2">
        <Button
          // Foreground, not the link variant's primary, which is a mid grey on the dark bar.
          className="px-0 text-foreground underline"
          disabled={switching.pending}
          onClick={() => switching.run(moved.organizationId)}
          size="sm"
          variant="link"
        >
          Switch to {moved.organizationName}
        </Button>
        <Button
          aria-label="Dismiss"
          disabled={dismiss.isPending}
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
