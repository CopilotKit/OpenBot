import type { LauncherState } from "@openbot/shared/openbot-browser";
import { IconBrowser } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { toast } from "@/components/ui/toast";
import { openBrowserMutationOptions } from "@/lib/browser/mutations";
import { browserStateQueryOptions } from "@/lib/browser/queries";
import { queryClient } from "@/query-client";
import { elapsed, RecordingMark, useSecondsSince } from "./recording";

const BUTTON_CLASS = "hover:bg-foreground/5 h-10";

/**
 * The sidebar's Browser button, beside Bots, Capabilities and Connections: the person's own browser, with the Recorder
 * in it, in one click.
 *
 * Where the browser is a window on the person's desktop (OpenBot Desktop, `shows: "native"`), the click opens it, or
 * brings it to the front, and leaves the person where they are in OpenBot: they record with the Recorder's own button in
 * that window's toolbar. Where it is a browser in the page (hosted OpenBot, `shows: "screen"`), the click takes them to
 * the Browser page, which is the browser. While a recording runs the button carries its red dot either way, named for
 * the recording.
 *
 * Drawn only once the server has said OpenBot can run a browser for this person (`available`). While it is asked, and
 * when it cannot be asked, there is no button, rather than one that opens a page saying there is nothing there.
 */
export function BrowserNavItem() {
  const state = useQuery(browserStateQueryOptions());
  if (state.isPending || !state.data?.available) return null;
  return (
    <SidebarMenuItem>
      {/* A server from before `shows` only had the Browser page, so it keeps leading there. */}
      {state.data.shows === "native" ? (
        <OpenWindowButton recorder={state.data.recorder} />
      ) : (
        <BrowserPageLink recorder={state.data.recorder} />
      )}
    </SidebarMenuItem>
  );
}

/**
 * A button, not a link: it does something and goes nowhere. While the browser is opening it says so and takes no
 * further click (`aria-disabled` rather than `disabled`, so it keeps the keyboard's focus), and when the server refuses,
 * its sentence is a toast, because the person stays wherever they were in OpenBot and the button has no page of its own
 * to say it on.
 */
function OpenWindowButton({ recorder }: { recorder?: LauncherState }) {
  const open = useMutation(openBrowserMutationOptions(queryClient));
  const recording = useRecordingLabel(recorder);
  const opening = open.isPending;
  return (
    <SidebarMenuButton
      aria-busy={opening || undefined}
      aria-disabled={opening || undefined}
      className={BUTTON_CLASS}
      onClick={() => {
        if (open.isPending) return;
        open.mutate(undefined, {
          onError: (error) =>
            toast.add({
              // One at a time: a second refusal replaces the first rather than stacking under it.
              id: "browser-open-refused",
              title: error.message,
              type: "error",
              priority: "high",
            }),
        });
      }}
      tooltip={recordingTooltip(recording)}
    >
      <BrowserLabel>
        {opening ? (
          <span className="ml-auto text-xs text-muted-foreground">
            Opening…
          </span>
        ) : recording ? (
          <RecordingDot {...recording} />
        ) : null}
      </BrowserLabel>
    </SidebarMenuButton>
  );
}

/** A link, as it has always been: the Browser page is where a browser in the page is. */
function BrowserPageLink({ recorder }: { recorder?: LauncherState }) {
  const recording = useRecordingLabel(recorder);
  return (
    <SidebarMenuButton
      className={BUTTON_CLASS}
      render={(props) => (
        <Link
          {...props}
          to="/browser"
          activeProps={{ className: "bg-foreground/5" }}
        />
      )}
      tooltip={recordingTooltip(recording)}
    >
      <BrowserLabel>
        {recording ? <RecordingDot {...recording} /> : null}
      </BrowserLabel>
    </SidebarMenuButton>
  );
}

/** The icon and the name every item in this part of the sidebar has, and what goes at the end of the row. */
function BrowserLabel({ children }: { children?: ReactNode }) {
  return (
    <>
      <div className="size-[28px] flex items-center justify-center">
        <IconBrowser />
      </div>
      <span className="text-sm">Browser</span>
      {children}
    </>
  );
}

type RecordingLabel = { label: string; live: boolean };

/**
 * What the recording running in the person's browser is called on the Browser button, from the Recorder's own report:
 * "Recording: Submit the receipt, 1:23", ticking while it runs. Null while nothing is being recorded. `live` while it
 * records, rather than starting or stopping, as the Browser page's own mark has it.
 */
function useRecordingLabel(
  recorder: LauncherState | undefined,
): RecordingLabel | null {
  const phase = recorder?.phase ?? "idle";
  const seconds = useSecondsSince(
    phase === "recording" ? recorder?.startedAt : undefined,
  );
  if (!recorder || phase === "idle") return null;
  const named = recorder.title ? `Recording: ${recorder.title}` : "Recording";
  const progress =
    phase === "starting"
      ? "starting"
      : phase === "stopping"
        ? "stopping"
        : recorder.startedAt === undefined
          ? null
          : elapsed(seconds);
  return {
    label: progress ? `${named}, ${progress}` : named,
    live: phase === "recording",
  };
}

/**
 * The tooltip naming the recording, shown beside the button whether or not the sidebar is collapsed. Always given, and
 * hidden while nothing records, so the button is never remounted (and never loses the keyboard's focus) as a recording
 * starts and stops.
 */
function recordingTooltip(recording: RecordingLabel | null) {
  return {
    children: recording?.label ?? "Browser",
    hidden: recording === null,
  };
}

/** The recording's red dot at the end of the row, named as the tooltip names it (Base UI's tooltip is never read out). */
function RecordingDot({ label, live }: RecordingLabel) {
  return (
    <span aria-label={label} className="ml-auto" role="img">
      <RecordingMark live={live} />
    </span>
  );
}
