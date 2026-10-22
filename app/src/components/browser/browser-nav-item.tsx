import type { RealBrowser } from "@openbot/shared/openbot-browser";
import type { RecorderActivity } from "@openbot/shared/recorder-api";
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
 * that window's toolbar. That window is the person's own everyday Chrome or Edge once the Recorder is in it, and until
 * then, where the Recorder is published, the click opens its store page there for them to add it. Where it is a browser
 * in the page (hosted OpenBot, `shows: "screen"`), the click takes them to the Browser page, which is the browser.
 *
 * While any of the person's Recorders records (`activity`: the OpenBot browser's, or one in their everyday browser),
 * the button carries a red dot either way, named for the recording.
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
        <OpenWindowButton activity={state.data.activity} />
      ) : (
        <BrowserPageLink activity={state.data.activity} />
      )}
    </SidebarMenuItem>
  );
}

/** The one toast a refused open says itself in. */
const REFUSED_TOAST = "browser-open-refused";
/** The one toast that says the Recorder's store page opened. */
const STORE_TOAST = "browser-store-opened";

const REAL_BROWSER_NAMES: Record<RealBrowser, string> = {
  chrome: "Google Chrome",
  msedge: "Microsoft Edge",
};

/**
 * What the person is told when the click opened the Recorder's page in the store of their own browser, rather than a
 * browser with the Recorder in it: the page is there, in the browser named, and adding it is what lets them record in
 * that browser. Once it is added and connected, the same click brings that browser forward.
 */
export function storeOpenedSentence(browser: RealBrowser): string {
  return `The OpenBot Recorder's page is open in ${REAL_BROWSER_NAMES[browser]}. Add it there to record in your own browser.`;
}

/**
 * A button, not a link: it does something and goes nowhere. While the browser is opening it says so and takes no
 * further click, and when the server refuses, its sentence is a toast, because the person stays wherever they were in
 * OpenBot and the button has no page of its own to say it on.
 *
 * Opening is busy (`aria-busy`), not disabled: the click handler ignores a click while it opens, and the row keeps its
 * full contrast and the keyboard's focus. The sidebar draws `aria-disabled` at half opacity, and the seventh end-to-end
 * run found "Opening…" too faint to read that way.
 *
 * The refusal stays until the person closes it, as every error toast does (components/ui/toast.tsx), and goes once an
 * open succeeds, because it is no longer true. A click that opened the Recorder's store page in the person's own
 * browser says so in a short note of its own, because nothing else in OpenBot changes to show it.
 */
function OpenWindowButton({ activity }: { activity?: RecorderActivity }) {
  const open = useMutation(openBrowserMutationOptions(queryClient));
  const recording = useRecordingLabel(activity);
  const opening = open.isPending;
  return (
    <SidebarMenuButton
      aria-busy={opening || undefined}
      className={BUTTON_CLASS}
      onClick={() => {
        if (open.isPending) return;
        open.mutate(undefined, {
          onSuccess: (answer) => {
            toast.close(REFUSED_TOAST);
            if ("opened" in answer && answer.opened === "store")
              toast.add({
                // One at a time: a second click replaces the note rather than stacking another under it.
                id: STORE_TOAST,
                title: storeOpenedSentence(answer.browser),
                type: "info",
              });
          },
          onError: (error) =>
            toast.add({
              // One at a time: a second refusal replaces the first rather than stacking under it.
              id: REFUSED_TOAST,
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
function BrowserPageLink({ activity }: { activity?: RecorderActivity }) {
  const recording = useRecordingLabel(activity);
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
 * What the recording running in one of the person's browsers is called on the Browser button, from its Recorder's own
 * report as the server passes it on: "Recording: Submit the receipt, 1:23", ticking while it runs. Null while nothing is
 * being recorded. `live` while it records, rather than starting or stopping, as the Browser page's own mark has it.
 */
function useRecordingLabel(
  activity: RecorderActivity | undefined,
): RecordingLabel | null {
  const phase = activity?.phase ?? "idle";
  const seconds = useSecondsSince(
    phase === "recording" ? activity?.startedAt : undefined,
  );
  if (!activity || phase === "idle") return null;
  const named = activity.title ? `Recording: ${activity.title}` : "Recording";
  const progress =
    phase === "starting"
      ? "starting"
      : phase === "stopping"
        ? "stopping"
        : activity.startedAt === undefined
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
