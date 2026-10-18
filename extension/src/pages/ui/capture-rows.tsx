import type { LearningSpaceState } from "@openbot/shared/recorder-api";
import {
  IconDeviceDesktop,
  IconMicrophone,
  IconNetwork,
  IconSchool,
} from "@tabler/icons-react";
import { PageRows } from "@/components/layout/page-parts";
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
import type { CaptureStatus } from "../../protocol/messages";
import { learningSentence } from "../popup/record-form";

const UNJOINED =
  "Learning did not see this recording: OpenBot could not choose its Learning space in time. It still saves to OpenBot.";
const LEADING_STATUS = /^Learning capture is (?:paused|off):\s*/;

/** The sentence about a recording's Learning space; `unjoined` only arises from a pass, so only a recording shows it. */
export function recordingLearningSentence(
  learning: LearningSpaceState | undefined,
): string | null {
  if (!learning) return null;
  return learning.state === "unjoined" ? UNJOINED : learningSentence(learning);
}

const NOT_IN_A_SPACE = new Set<LearningSpaceState["state"]>([
  "unassigned",
  "missing",
  "unjoined",
]);

const INTELLIGENCE_STATUS: Record<CaptureStatus["intelligence"], string> = {
  off: "Off",
  connecting: "Connecting to Intelligence",
  streaming: "Streaming to Intelligence",
  retrying: "Retrying",
  held: "Paused",
  parked: "Off",
};

function plural(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`;
}

function describe(status: string, reason: string | undefined) {
  return reason ? `${status}. ${reason}` : status;
}

/** Learning capture's title and description lines for the capture status and the recording's Learning space. */
function learningLines(
  capture: CaptureStatus,
  learning: LearningSpaceState | undefined,
): { title: string; lines: string[] } {
  const reason = capture.intelligenceReason?.replace(LEADING_STATUS, "");
  const sentence = recordingLearningSentence(learning);
  const lines: string[] = [];
  let title = "Learning capture";
  if (capture.intelligence === "held") {
    title = "Learning capture is paused";
    if (reason) lines.push(reason);
    lines.push(
      "Your events are kept in this browser and sent when Intelligence accepts them; it tries again every 5 minutes.",
    );
  } else if (capture.intelligence === "parked") {
    title = "Learning capture is off";
    if (reason) lines.push(reason);
    lines.push(
      "Your events are kept in this browser. The Recorder tries again when the browser next starts.",
    );
  } else {
    if (learning && NOT_IN_A_SPACE.has(learning.state)) {
      title = "Not into a Learning space";
    } else {
      lines.push(describe(INTELLIGENCE_STATUS[capture.intelligence], reason));
    }
  }
  if (sentence) lines.push(sentence);
  const { rejected = 0, dropped = 0 } = capture.events ?? {};
  if (rejected > 0) {
    lines.push(
      `${plural(rejected, "event was", "events were")} refused by Intelligence`,
    );
  }
  if (dropped > 0) {
    lines.push(`${plural(dropped, "event", "events")} could not be sent`);
  }
  return { title, lines };
}

/** The Learning capture row, shared by the recording view and the after-stop view's still-sending list. */
export function LearningCaptureRow({
  capture,
  learning,
}: {
  capture: CaptureStatus;
  learning?: LearningSpaceState;
}) {
  const { title, lines } = learningLines(capture, learning);
  return (
    <Item size="sm">
      <ItemMedia variant="icon">
        <IconSchool />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{title}</ItemTitle>
        {lines.map((line) => (
          <ItemDescription key={line} className="line-clamp-none">
            {line}
          </ItemDescription>
        ))}
      </ItemContent>
    </Item>
  );
}

const NETWORK_STATUS: Record<CaptureStatus["network"], string> = {
  off: "Off",
  waiting: "Waiting for the page",
  debugger: "Capturing the network calls behind each page",
  page: "Capturing the page's own network calls",
  stopped: "Stopped",
};
const SCREEN_STATUS: Record<CaptureStatus["screen"], string> = {
  off: "Off",
  recording: "Recording this tab",
  failed: "Could not record the screen",
};
const VOICE_STATUS: Record<CaptureStatus["voice"], string> = {
  off: "Off",
  recording: "Recording your voice",
  unavailable: "Not available",
  failed: "Could not record your voice",
};

/** Learning capture, Network, Screen and Voice: what the Recorder is keeping, and why anything is off. */
export function CaptureRows({
  capture,
  learning,
  onRecordScreen,
}: {
  capture: CaptureStatus;
  /** The recording's Learning space, so "streaming" never hides one that could not be confirmed. */
  learning?: LearningSpaceState;
  onRecordScreen?: () => void;
}) {
  return (
    <PageRows>
      <LearningCaptureRow capture={capture} learning={learning} />
      <Separator />
      <Item size="sm">
        <ItemMedia variant="icon">
          <IconNetwork />
        </ItemMedia>
        <ItemContent>
          <ItemTitle>Network</ItemTitle>
          <ItemDescription className="line-clamp-none">
            {describe(NETWORK_STATUS[capture.network], capture.networkReason)}
          </ItemDescription>
        </ItemContent>
      </Item>
      <Separator />
      <Item size="sm">
        <ItemMedia variant="icon">
          <IconDeviceDesktop />
        </ItemMedia>
        <ItemContent>
          <ItemTitle>Screen</ItemTitle>
          <ItemDescription className="line-clamp-none">
            {describe(SCREEN_STATUS[capture.screen], capture.screenReason)}
          </ItemDescription>
        </ItemContent>
        {capture.screen === "off" && capture.screenReason && onRecordScreen ? (
          <ItemActions>
            <Button size="sm" onClick={onRecordScreen}>
              Record screen
            </Button>
          </ItemActions>
        ) : null}
      </Item>
      <Separator />
      <Item size="sm">
        <ItemMedia variant="icon">
          <IconMicrophone />
        </ItemMedia>
        <ItemContent>
          <ItemTitle>Voice</ItemTitle>
          <ItemDescription className="line-clamp-none">
            {describe(VOICE_STATUS[capture.voice], capture.voiceReason)}
          </ItemDescription>
        </ItemContent>
      </Item>
    </PageRows>
  );
}
