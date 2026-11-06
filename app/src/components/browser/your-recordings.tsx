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

/** How a recording ended, in words; null when it needs no badge (it arrived, or nobody can tell). */
function endedLabel(row: RecordingRow): string | null {
  if (row.ended === "sending") return "Still sending";
  if (row.ended === "missing") return "Not in Intelligence";
  if (row.ended !== "stopped") return null;
  const reason = row.reason ? STOP_REASONS[row.reason] : undefined;
  return reason ? `Stopped early: ${reason}` : "Stopped early";
}

/** The browser section's list of the person's own recordings, with how each one ended. */
export function YourRecordings() {
  const recordings = useInfiniteQuery(recordingsQueryOptions());
  if (recordings.isPending) return null;
  const unavailable = recordings.data?.pages[0]?.unavailable;
  const rows = recordings.data?.pages.flatMap((page) => page.recordings) ?? [];

  return (
    <PageSection title="Your recordings">
      {recordings.error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {recordings.error.message}
        </p>
      ) : unavailable ? (
        <p className="mt-4 text-muted-foreground text-sm">
          {unavailable === "unreachable"
            ? "Couldn't reach Intelligence to list your recordings. Try again in a moment."
            : "Intelligence isn't available, so your recordings can't be listed."}
        </p>
      ) : rows.length === 0 ? (
        <PageEmpty>
          No recordings yet. Record a task with the OpenBot extension to see it
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
}
