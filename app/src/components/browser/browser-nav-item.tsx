import type { RecorderActivity } from "@openbot/shared/recorder-api";
import { useQuery } from "@tanstack/react-query";
import { toast } from "@/components/ui/toast";
import { browserStateQueryOptions } from "@/lib/browser/queries";
import type { RecorderStore } from "@/lib/recorder/bridge";
import { elapsed, RecordingMark, useSecondsSince } from "./recording";

/** What the page and the Skills page call the place where a person teaches their Bots a task. */
export const TEACH_A_BOT = "Teach a Bot";

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

export type RecordingLabel = { label: string; live: boolean };

/**
 * The recording running in one of the person's browsers, as the main menu's Skills entry names it: "Recording: Submit
 * the receipt, 1:23", ticking while it runs. Teaching a Bot a task is how a skill is recorded, so Skills is where the
 * menu says one is live.
 *
 * Read from the server's `activity`, which folds in every Recorder the person has (the OpenBot browser's, or one in
 * their everyday browser), and only where OpenBot can run a browser for them (`available`). The read polls every
 * second while something records, so Stop takes the dot away as quickly (`browserStateQueryOptions`). Null while
 * nothing records. `live` while it records, as opposed to starting or stopping, as the Teach a Bot page's mark has it.
 */
export function useLiveRecording(): RecordingLabel | null {
  const state = useQuery(browserStateQueryOptions());
  const activity: RecorderActivity | undefined = state.data?.available
    ? state.data.activity
    : undefined;
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
 * The tooltip naming the recording, shown beside the entry whether or not the sidebar is collapsed. Always given, and
 * hidden while nothing records, so the entry is never remounted (and never loses the keyboard's focus) as a recording
 * starts and stops.
 */
export function recordingTooltip(
  recording: RecordingLabel | null,
  name: string,
) {
  return {
    children: recording?.label ?? name,
    hidden: recording === null,
  };
}

/** The recording's red dot at the end of the row, named as the tooltip names it (Base UI's tooltip is never read out). */
export function RecordingDot({ label, live }: RecordingLabel) {
  return (
    <span aria-label={label} className="ml-auto" role="img">
      <RecordingMark live={live} />
    </span>
  );
}
