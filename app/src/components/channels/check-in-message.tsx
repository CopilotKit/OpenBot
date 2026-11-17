import type { CheckInMessage } from "@openbot/shared/check-in-message";
import { IconRadar } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { SuggestionRow } from "@/components/suggestions/suggestion-row";
import { TaskCard } from "@/components/tasks/task-thread";
import {
  type ProactiveSuggestion,
  proactiveSettingsQueryOptions,
  proactiveSuggestionsQueryOptions,
} from "@/lib/proactive";
import { type BotTask, taskListQueryOptions } from "@/lib/tasks/queries";

/**
 * A check-in that found something, saying so in its own conversation: what the transcript draws
 * around the Bot's sentence for a message carrying `@openbot/shared/check-in-message`.
 *
 * {@link CheckInRan} goes above the sentence and {@link CheckInItems} under it. The sentence itself
 * is the Bot's and is drawn by the transcript as any reply of its is.
 */

/**
 * The line that says a check-in ran, what it watches and when.
 *
 * Shaped like the transcript's "Routine ran." line, and for the same reason: start-aligned and
 * muted because this is an event and not something anybody typed, with the radar check-ins wear
 * everywhere else in the app. What the check-in watches is read live from the person's check-ins,
 * so one renamed since says its name as it is now, and one removed since says only when it ran.
 */
export function CheckInRan({
  checkInId,
  ranAt,
}: Pick<CheckInMessage, "checkInId" | "ranAt">) {
  const subject = useQuery(proactiveSettingsQueryOptions()).data?.find(
    (setting) => setting.id === checkInId,
  )?.subject;
  const when = new Date(ranAt);
  return (
    <div
      className="flex min-w-0 items-baseline gap-2 text-muted-foreground text-sm"
      data-check-in-ran={checkInId}
    >
      <IconRadar aria-hidden className="size-4 shrink-0 translate-y-0.5" />
      <span className="min-w-0">
        <span className="font-medium">Check-in ran.</span>{" "}
        {subject ? `${subject}, ` : null}
        <time dateTime={when.toISOString()} title={when.toLocaleString()}>
          {clockTime(when, new Date())}
        </time>
      </span>
    </div>
  );
}

/**
 * When a check-in ran, on the person's own clock: the time alone for one that ran today, with the
 * day for an older one, and the year once that is not this year.
 */
export function clockTime(when: Date, now: Date): string {
  const time = when.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  if (when.toDateString() === now.toDateString()) return time;
  const day = when.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(when.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
  return `${day}, ${time}`;
}

/** What one stretch of a check-in's items is drawn as. */
type Drawn =
  | { kind: "open"; id: string; item: ProactiveSuggestion }
  | { kind: "started"; id: string; task: BotTask }
  | { kind: "closed"; id: string; count: number };

/**
 * A card for each thing the check-in raised, in the state each is in NOW.
 *
 * LIVE, NEVER WHAT THE MESSAGE SAID. The message names its items and nothing more. What each one is
 * is read when the cards are drawn, from the two lists the Needs you board reads: the open items,
 * and the person's tasks. So a message scrolled back to days later never offers Work on it for
 * something already under way.
 *
 * - STILL OPEN: the board's own row (`SuggestionRow`) on a card, with its Work on it and its ✕.
 *   The same component, so the same request: an item answered here leaves the board, and one
 *   answered on the board changes here, because both read the one list those writes refresh.
 * - STARTED: the task it became, as the card every task has in a conversation (`TaskCard`). A task
 *   says which item it was started from (`suggestionId`), which is how it is found.
 * - NEITHER: one muted line. The item was dismissed, or a later check-in cleared it as no longer
 *   needed, or its task was finished long enough ago to have left the list. The API lists open
 *   items only, so which of those it was, and what the item was called, cannot be read back, and
 *   the line does not guess. Items in a row that are closed share one line with their count.
 *
 * Nothing is drawn while either list is still being read: no placeholder, and above all no "no
 * longer needs you" said of an item that is about to turn out open.
 *
 * NOR OF ONE THAT WAS JUST STARTED. A start takes an item off one list and puts a task on the other,
 * and the two are read apart: after Work on it here both are read again and come back in either
 * order, and after Work on it in another window each arrives on its own timer, up to half a minute
 * apart. In between, the item is on neither list, which is exactly what closed looks like. So an
 * item this card has drawn open is only called closed by a task list read AFTER the read that found
 * it gone. Until there is one the item is drawn as nothing, and that read is asked for at once
 * instead of waited for. An item that was already gone when the card was first drawn has no such
 * moment to guard, and is closed on the first answer.
 */
export function CheckInItems({ itemIds }: Pick<CheckInMessage, "itemIds">) {
  const open = useQuery(proactiveSuggestionsQueryOptions());
  const tasks = useQuery(taskListQueryOptions());
  /*
   * For each item this card has drawn open: null while it still is, then the moment of the read
   * that first found it gone. Kept across renders and written during one, as the paced reveal keeps
   * its own clock: the same answers always write the same thing, and an effect would be a frame
   * late, which is the frame that would say "no longer needs you".
   */
  const leftAt = useRef(new Map<string, number | null>());
  const drawn: Drawn[] = [];
  const unsettled: string[] = [];
  if (open.data && tasks.data) {
    for (const id of itemIds) {
      const item = open.data.find((candidate) => candidate.id === id);
      if (item) leftAt.current.set(id, null);
      else if (leftAt.current.get(id) === null)
        leftAt.current.set(id, open.dataUpdatedAt);
      // The task first: for a moment after Work on it an item can be on both lists.
      const task = tasks.data.find(
        (candidate) => candidate.suggestionId === id,
      );
      if (task) {
        drawn.push({ kind: "started", id, task });
        continue;
      }
      if (item) {
        drawn.push({ kind: "open", id, item });
        continue;
      }
      const left = leftAt.current.get(id);
      if (typeof left === "number" && tasks.dataUpdatedAt < left) {
        unsettled.push(id);
        continue;
      }
      const last = drawn.at(-1);
      if (last?.kind === "closed") last.count += 1;
      else drawn.push({ kind: "closed", id, count: 1 });
    }
  }
  /*
   * Asked once for each set of items in doubt, never in a loop: a read that fails leaves the same
   * items in doubt, and they wait for the list's own next read rather than hammer a server that is
   * already struggling. A read already on its way is joined, not restarted.
   */
  const waitingOn = unsettled.join("\n");
  const readTasks = tasks.refetch;
  useEffect(() => {
    if (waitingOn) void readTasks({ cancelRefetch: false });
  }, [waitingOn, readTasks]);
  if (!open.data || !tasks.data) {
    const error = open.error ?? tasks.error;
    return error ? (
      <p className="my-2 text-muted-foreground text-sm" role="alert">
        {error.message}
      </p>
    ) : null;
  }
  return (
    <div className="flex w-full flex-col" data-check-in-items>
      {drawn.map((piece) =>
        piece.kind === "started" ? (
          <div
            className="contents"
            data-check-in-item={piece.id}
            data-state="started"
            key={piece.id}
          >
            <TaskCard
              channelId={piece.task.channelId}
              taskId={piece.task.id}
              title={piece.task.title}
            />
          </div>
        ) : piece.kind === "open" ? (
          <div
            className="my-2 w-full max-w-2xl rounded-xl border border-border"
            data-check-in-item={piece.id}
            data-state="open"
            key={piece.id}
          >
            <SuggestionRow inConversation suggestion={piece.item} />
          </div>
        ) : (
          <p
            className="my-2 text-muted-foreground text-sm"
            data-check-in-item={piece.id}
            data-state="closed"
            key={piece.id}
          >
            {piece.count === 1
              ? "1 item no longer needs you."
              : `${piece.count} items no longer need you.`}
          </p>
        ),
      )}
    </div>
  );
}
