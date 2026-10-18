import type { LearningSpaceState } from "@openbot/shared/recorder-api";
import { IconNetwork, IconSchool } from "@tabler/icons-react";
import { PageRows } from "@/components/layout/page-parts";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import type { CaptureStatus, RecorderState } from "../../protocol/messages";
import { learningSentence } from "../popup/record-form";

const UNJOINED =
  "Learning did not see this recording: OpenBot could not choose its Learning space in time. It still saves to OpenBot.";
const LEADING_STATUS = /^Learning capture is (?:paused|off):\s*/;
const HELD_LINE =
  "Your events are kept in this browser and sent when Intelligence accepts them; it tries again every 5 minutes.";
const PARKED_LINE =
  "Your events are kept in this browser. The Recorder tries again when the browser next starts.";

/** A Task 11 reason without its leading "Learning capture is paused/off:", which the row's title already says, as a
 * sentence of its own (the table's reasons go on in lower case after that phrase). */
export function stripCaptureStatus(reason: string): string {
  const line = reason.replace(LEADING_STATUS, "");
  return line.charAt(0).toUpperCase() + line.slice(1);
}

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

/** The Learning capture line: a reason that already says "Retrying" stands alone, never "Retrying. ... Retrying; ...". */
function describeIntelligence(
  intelligence: CaptureStatus["intelligence"],
  reason: string | undefined,
) {
  return intelligence === "retrying" && reason && /\bRetrying\b/.test(reason)
    ? reason
    : describe(INTELLIGENCE_STATUS[intelligence], reason);
}

type RowText = { title: string; lines: string[] };

/** A stop that keeps every event: the status as the title, then why, then when it tries again. */
function keptText(parked: boolean, reason: string | undefined): RowText {
  return {
    title: parked ? "Learning capture is off" : "Learning capture is paused",
    lines: [
      ...(reason ? [stripCaptureStatus(reason)] : []),
      parked ? PARKED_LINE : HELD_LINE,
    ],
  };
}

/** What the row says about the recording's Learning space, after the capture status, so neither hides the other. */
function spaceLines(learning: LearningSpaceState | undefined): string[] {
  const sentence = recordingLearningSentence(learning);
  return [
    ...(learning && NOT_IN_A_SPACE.has(learning.state)
      ? ["Not into a Learning space"]
      : []),
    ...(sentence ? [sentence] : []),
  ];
}

/** Learning capture's title and description lines for a running recording's capture status and Learning space. */
function captureText(
  capture: CaptureStatus,
  learning: LearningSpaceState | undefined,
): RowText {
  const status =
    capture.intelligence === "held" || capture.intelligence === "parked"
      ? keptText(capture.intelligence === "parked", capture.intelligenceReason)
      : {
          title: "Learning capture",
          lines: [
            describeIntelligence(
              capture.intelligence,
              capture.intelligenceReason &&
                stripCaptureStatus(capture.intelligenceReason),
            ),
          ],
        };
  const { rejected = 0, dropped = 0 } = capture.events ?? {};
  return {
    title: status.title,
    lines: [
      ...status.lines,
      ...spaceLines(learning),
      ...(rejected > 0
        ? [
            `${plural(rejected, "event was", "events were")} refused by Intelligence`,
          ]
        : []),
      ...(dropped > 0
        ? [`${plural(dropped, "event", "events")} could not be sent`]
        : []),
    ],
  };
}

function LearningRow({ title, lines }: RowText) {
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

/** The Learning capture row of a running recording. */
export function LearningCaptureRow({
  capture,
  learning,
}: {
  capture: CaptureStatus;
  learning?: LearningSpaceState;
}) {
  return <LearningRow {...captureText(capture, learning)} />;
}

/**
 * The Learning capture row after Stop, for what is still sending. A finished recording's capture status is back to
 * idle (the service worker ignores the document's status once nothing records), so this reads the drains instead:
 * events kept by a stop (held or parked), or else a recording that is still streaming.
 */
export function SendingLearningRow({
  kept,
  learning,
}: {
  kept: RecorderState["kept"];
  learning?: LearningSpaceState;
}) {
  const status = kept
    ? keptText(kept.parked, kept.reason)
    : {
        title: "Learning capture",
        lines: ["Sending the rest of this recording to Intelligence"],
      };
  return (
    <LearningRow
      title={status.title}
      lines={[...status.lines, ...spaceLines(learning)]}
    />
  );
}

const NETWORK_STATUS: Record<CaptureStatus["network"], string> = {
  off: "Off",
  waiting: "Waiting for the page",
  debugger: "Capturing the network calls behind each page",
  page: "Capturing the page's own network calls",
  stopped: "Stopped",
};
/** Learning capture and Network: what the Recorder is keeping, and why anything is off. */
export function CaptureRows({
  capture,
  learning,
}: {
  capture: CaptureStatus;
  /** The recording's Learning space, so "streaming" never hides one that could not be confirmed. */
  learning?: LearningSpaceState;
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
    </PageRows>
  );
}
