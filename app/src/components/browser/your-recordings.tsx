import type { LauncherState } from "@openbot/shared/openbot-browser";
import type { RecordingRow } from "@openbot/shared/recorder-api";
import { IconVideo } from "@tabler/icons-react";
import { useInfiniteQuery } from "@tanstack/react-query";
import React from "react";
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
  if (row.ended === "missing") return "Not in the back end";
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

/**
 * The browser section's list of the person's own recordings, with how each one ended.
 *
 * `variant="pane"` frames it as a strip of its own under a browser that fills the page: capped, scrolling, and drawn
 * only once there is something to show, so no empty strip appears while the list loads. `waiting` while a stopped
 * recording has not reached the back end yet (`recordingOnItsWay`): the list asks again until it lands.
 */
export function YourRecordings({
  variant = "page",
  waiting = false,
}: {
  variant?: "page" | "pane";
  waiting?: boolean;
}) {
  const recordings = useInfiniteQuery(recordingsQueryOptions({ waiting }));
  if (recordings.isPending) return null;
  const unavailable = recordings.data?.pages.at(-1)?.unavailable;
  const rows = recordings.data?.pages.flatMap((page) => page.recordings) ?? [];

  // A failed "Show more" or refresh keeps the rows already loaded: the error goes below them, where Show more retries.
  const failure = recordings.error;
  const section = (
    <PageSection title="Your recordings">
      {failure && rows.length === 0 ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {failure.message}
        </p>
      ) : rows.length === 0 && !recordings.hasNextPage && !unavailable ? (
        <PageEmpty>
          No recordings yet. Record a task with the OpenBot Recorder to see it
          here.
        </PageEmpty>
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
                ? "Couldn't reach the back end to list your recordings. Try again in a moment."
                : "The back end isn't available, so your recordings can't be listed."}
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
  // Capped and scrolling on its own, in the page column's width and padding, so many rows cannot squeeze the browser.
  return (
    <div className="max-h-[40%] shrink-0 overflow-y-auto border-t border-border">
      <div className="mx-auto w-full max-w-3xl px-4 pb-8 [&>section]:mt-6">
        {section}
      </div>
    </div>
  );
}
