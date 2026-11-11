import type { LauncherState } from "@openbot/shared/openbot-browser";
import type { RecordingRow } from "@openbot/shared/recorder-api";
import { IconVideo } from "@tabler/icons-react";
import { useInfiniteQuery } from "@tanstack/react-query";
import React, { type ReactNode } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { recordingsQueryOptions } from "@/lib/recorder/queries";

const STOP_REASONS: Record<string, string> = {
  disconnected: "disconnected",
  "signed-out": "signed out",
  interrupted: "browser closed",
};

/**
 * How a recording ended, in words; null when it needs no badge (it arrived). An `unknown` one, whose outcome never
 * arrived, is badged too, so it never reads as a success.
 */
function endedLabel(row: RecordingRow): string | null {
  if (row.ended === "sending") return "Still sending";
  if (row.ended === "missing") return "Not in the backend";
  if (row.ended === "unknown") return "No result";
  if (row.ended !== "stopped") return null;
  const reason = row.reason ? STOP_REASONS[row.reason] : undefined;
  return reason ? `Stopped early: ${reason}` : "Stopped early";
}

/**
 * Whether the recording Stop ended last has not reached the back end yet: still on its way, or kept in the browser and
 * sent again later. Until it lands it has no row, so the list asks again meanwhile (`waiting`).
 */
export function recordingOnItsWay(
  lastStopped: LauncherState["lastStopped"] | undefined,
): boolean {
  return (
    !!lastStopped &&
    !lastStopped.discarded &&
    (lastStopped.sending === true || lastStopped.kept !== undefined)
  );
}

const EMPTY = "No recordings yet. Each task you record shows up here.";

/**
 * The browser section's list of the person's own recordings, with how each one ended.
 *
 * `variant="pane"` sets it under the browser, in the browser's column: capped, scrolling, and drawn
 * only once there is something to show, so no empty strip appears while the list loads. `waiting` while a stopped
 * recording has not reached the back end yet (`recordingOnItsWay`): the list asks again until it lands. `action` sits
 * on the title's line (Teach a Bot's way to what the recordings taught).
 */
export function YourRecordings({
  variant = "page",
  waiting = false,
  action,
}: {
  variant?: "page" | "pane";
  waiting?: boolean;
  action?: ReactNode;
}) {
  const recordings = useInfiniteQuery(recordingsQueryOptions({ waiting }));
  if (recordings.isPending) return null;
  const unavailable = recordings.data?.pages.at(-1)?.unavailable;
  const rows = recordings.data?.pages.flatMap((page) => page.recordings) ?? [];

  // A failed "Show more" or refresh keeps the rows already loaded: the error goes below them, where Show more retries.
  const failure = recordings.error;
  const section = (
    <PageSection action={action} title="Your recordings">
      {failure && rows.length === 0 ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {failure.message}
        </p>
      ) : rows.length === 0 && !recordings.hasNextPage && !unavailable ? (
        variant === "pane" ? (
          // One line under the browser, not a box: every bit of height here is taken from the page above.
          <p className="mt-1 text-muted-foreground text-sm">{EMPTY}</p>
        ) : (
          <PageEmpty>{EMPTY}</PageEmpty>
        )
      ) : (
        <>
          <PageRows>
            {rows.map((row, index) => {
              const ended = endedLabel(row);
              return (
                <React.Fragment key={row.id}>
                  {index > 0 ? <Separator /> : null}
                  <Item size="sm">
                    <ItemMedia variant="icon">
                      <IconVideo />
                    </ItemMedia>
                    <ItemContent>
                      <ItemTitle>{row.title ?? "Untitled recording"}</ItemTitle>
                      <ItemDescription>
                        {new Date(row.recordedAt).toLocaleString()}
                      </ItemDescription>
                    </ItemContent>
                    {ended ? (
                      <ItemActions>
                        <span className="text-muted-foreground text-sm">
                          {ended}
                        </span>
                      </ItemActions>
                    ) : null}
                  </Item>
                </React.Fragment>
              );
            })}
          </PageRows>
          {unavailable ? (
            <p className="mt-4 text-muted-foreground text-sm">
              {unavailable === "unreachable"
                ? "Couldn't reach the backend to list your recordings. Try again in a moment."
                : "The backend isn't available, so your recordings can't be listed."}
            </p>
          ) : null}
          {failure ? (
            <p className="mt-4 text-destructive text-sm">
              {recordings.isFetchNextPageError
                ? "Couldn't load more recordings. Try again."
                : "Couldn't refresh your recordings."}
            </p>
          ) : null}
          {recordings.hasNextPage ? (
            <Button
              className="mt-3"
              disabled={recordings.isFetchingNextPage}
              onClick={() => recordings.fetchNextPage()}
              size="sm"
              variant="outline"
            >
              Show more
            </Button>
          ) : null}
        </>
      )}
    </PageSection>
  );
  if (variant === "page") return section;
  // Under the browser, in its column: the height left under the window (`BrowserDesk`), scrolling on its own.
  return (
    <div
      className="min-h-0 flex-1 overflow-y-auto [&>section]:mt-0"
      data-slot="recordings-strip"
    >
      {section}
    </div>
  );
}
