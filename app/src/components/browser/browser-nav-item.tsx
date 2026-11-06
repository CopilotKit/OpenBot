import type { RecorderActivity } from "@openbot/shared/recorder-api";
import { IconChalkboardTeacher } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { toast } from "@/components/ui/toast";
import { browserStateQueryOptions } from "@/lib/browser/queries";
import type { RecorderStore } from "@/lib/recorder/bridge";
import { elapsed, RecordingMark, useSecondsSince } from "./recording";

const BUTTON_CLASS = "hover:bg-foreground/5 h-10";
/** What the sidebar and the page call the place where a person teaches their Bots a task. */
export const TEACH_A_BOT = "Teach a Bot";

/**
 * The sidebar's Teach a Bot link, beside Bots, Capabilities and Connections. It takes the person to the page where they
 * open their own browser, with the Recorder in it, and record a task. The click opens nothing itself: the page has Open.
 *
 * While any of the person's Recorders records (`activity`: the OpenBot browser's, or one in their everyday browser), the
 * link carries a red dot, named for the recording.
 *
 * Drawn only once the server has said OpenBot can run a browser for this person (`available`). While that is asked, and
 * when the server cannot be asked, there is no link, rather than one to a page saying there is nothing there.
 */
export function BrowserNavItem() {
  const state = useQuery(browserStateQueryOptions());
  if (state.isPending || !state.data?.available) return null;
  return (
    <SidebarMenuItem>
      <BrowserPageLink activity={state.data.activity} />
    </SidebarMenuItem>
  );
}

/** The one toast that says the Recorder's store page opened. */
const STORE_TOAST = "browser-store-opened";

const STORE_NAMES: Record<RecorderStore, string> = {
  chrome: "Google Chrome",
  edge: "Microsoft Edge",
};

/**
 * What the person is told when Settings, Browsers opened the Recorder's store page in a new tab of the browser OpenBot is
 * open in: adding it there is what lets them record from here.
 */
export function storeTabSentence(store: RecorderStore): string {
  return `The OpenBot Recorder's page is open in a new tab. Add it to ${STORE_NAMES[store]} to record from OpenBot.`;
}

/** The short note that waits in OpenBot for a person who opened the Recorder's store page in a new tab: one at a time,
 * so a second click replaces it rather than stacking another under it. */
export function noteStoreTabOpened(store: RecorderStore): void {
  toast.add({ id: STORE_TOAST, title: storeTabSentence(store), type: "info" });
}

/** A link to the Teach a Bot page. */
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
        <IconChalkboardTeacher />
      </div>
      <span className="text-sm">{TEACH_A_BOT}</span>
      {children}
    </>
  );
}

type RecordingLabel = { label: string; live: boolean };

/**
 * What the recording running in one of the person's browsers is called on the Teach a Bot link, from its Recorder's own
 * report as the server passes it on: "Recording: Submit the receipt, 1:23", ticking while it runs. Null while nothing is
 * being recorded. `live` while it records, rather than starting or stopping, as the page's own mark has it.
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
 * The tooltip naming the recording, shown beside the link whether or not the sidebar is collapsed. Always given, and
 * hidden while nothing records, so the link is never remounted (and never loses the keyboard's focus) as a recording
 * starts and stops.
 */
function recordingTooltip(recording: RecordingLabel | null) {
  return {
    children: recording?.label ?? TEACH_A_BOT,
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
