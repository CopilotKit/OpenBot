import { IconPlayerPause, IconPlayerPlay } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Switch } from "@/components/ui/switch";
import { setPausedAllMutationOptions } from "@/lib/bot-lifecycle/mutations";
import { pausedAllQueryOptions } from "@/lib/bot-lifecycle/queries";
import { queryClient } from "@/query-client";

/** Whether the person paused all their Bots, false until the answer is in. */
export function usePausedAll(): boolean {
  return useQuery(pausedAllQueryOptions()).data === true;
}

/**
 * "All your Bots are paused." with Resume all, where a paused Bot's banner sits: on Bots, on
 * Routines and on each Bot's page. Nothing while they are not.
 */
export function PausedAllBanner() {
  const pausedAll = usePausedAll();
  const resume = useMutation(setPausedAllMutationOptions(queryClient));
  if (!pausedAll) return null;
  return (
    <div
      className="flex items-center justify-between gap-3 rounded-lg bg-secondary px-3.5 py-2.5"
      data-paused-all
      role="status"
    >
      <p className="flex items-center gap-2 text-sm">
        <IconPlayerPause aria-hidden className="size-4 shrink-0" />
        All your Bots are paused.
      </p>
      <Button
        disabled={resume.isPending}
        onClick={() => resume.mutate(false)}
        size="sm"
        variant="outline"
      >
        {resume.isPending ? "Resuming…" : "Resume all"}
      </Button>
    </div>
  );
}

/**
 * The switch for all of the person's Bots, the first row of Routines' every-Bot card. On means they
 * work, as a Bot's own Active row reads. Off is the same pause a Bot's own is, for every Bot at once;
 * each Bot's own state is kept underneath, so turning this back on returns them as they were.
 */
export function AllBotsActiveRow() {
  const pausedAll = usePausedAll();
  const save = useMutation(setPausedAllMutationOptions(queryClient));
  // The switch follows the press while the save is out, and the stored answer after.
  const active = save.isPending ? !save.variables : !pausedAll;
  return (
    <Item size="sm">
      <ItemMedia variant="icon">
        {active ? <IconPlayerPlay /> : <IconPlayerPause />}
      </ItemMedia>
      <ItemContent>
        <ItemTitle>All Bots active</ItemTitle>
        <ItemDescription>
          {active
            ? "Your Bots work on their routines, goals, hand-offs and follow-ups."
            : "Paused. No Bot works for you until you turn this back on. You can still talk to one here."}
        </ItemDescription>
        {save.error ? (
          <ItemDescription className="text-destructive" role="alert">
            {save.error.message}
          </ItemDescription>
        ) : null}
      </ItemContent>
      <ItemActions>
        <Switch
          aria-label="All Bots active"
          checked={active}
          disabled={save.isPending}
          onCheckedChange={(next) => save.mutate(!next)}
        />
      </ItemActions>
    </Item>
  );
}
