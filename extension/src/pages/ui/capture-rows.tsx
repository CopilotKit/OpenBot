import type { LearningSpaceState } from "@openbot/shared/recorder-api";
import {
  IconMicrophone,
  IconMicrophoneOff,
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
  ItemFooter,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import type {
  CaptureStatus,
  RecorderState,
  VoiceCapture,
} from "../../protocol/messages";
import { learningSentence } from "../popup/record-form";

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

const NOT_IN_A_SPACE = new Set<LearningSpaceState["state"]>([
  "unassigned",
  "missing",
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
  const sentence = learning ? learningSentence(learning) : null;
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
function LearningCaptureRow({
  capture,
  learning,
}: {
  capture: CaptureStatus;
  learning?: LearningSpaceState;
}) {
  return <LearningRow {...captureText(capture, learning)} />;
}

/**
 * The Learning capture row after Stop, for events kept by a stop (held or parked). A finished recording's capture status
 * is back to idle (the service worker ignores the document's status once nothing records), so this reads the drains
 * instead; without kept events it says the rest is still sending.
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
  debugger: "Capturing what each step saves",
  page: "Capturing what each step saves, from inside the page",
  stopped: "Stopped",
};
export type VoiceActions = {
  /** The switch: true mutes the narration, false turns it on again (also the way to try again after a failure). */
  onMute: (muted: boolean) => void;
  /** Opens the setup page, offered when the browser has not let the Recorder use the microphone. */
  onAllowMicrophone: () => void;
  /** Downloads the language the browser has to have on the computer before it can turn speech into text there, on the
   * person's click, and turns voice on: it starts once the language is there. */
  onDownload?: (language: string) => void;
};

/** What the Voice row says under its title: that it listens, or why it does not. */
function voiceLine(voice: VoiceCapture): string {
  switch (voice.state) {
    case "starting":
      // While the browser downloads the language, why voice has not started yet.
      return voice.reason ?? "Starting the microphone";
    case "listening":
      return "Listening";
    case "muted":
      return "Muted. Turn it on to narrate what you do.";
    case "failed":
      return voice.reason ?? "Voice stopped. Recording goes on without it.";
  }
}

/** The person's narration: listening (with the last words heard), muted, or why it stopped, and the switch that mutes
 * it. It sits with the recording's title, above the capture rows, so the live state and the words stay in view in
 * Chrome's 600px popup. */
export function VoiceRow({
  voice,
  actions,
}: {
  voice: VoiceCapture;
  actions?: VoiceActions;
}) {
  const on = voice.state === "starting" || voice.state === "listening";
  const listening = voice.state === "listening";
  return (
    <Item size="sm">
      <ItemMedia variant="icon">
        {on ? <IconMicrophone /> : <IconMicrophoneOff />}
      </ItemMedia>
      <ItemContent>
        <ItemTitle>Voice</ItemTitle>
        <ItemDescription className="line-clamp-none">
          {listening ? (
            <span className="inline-flex items-center gap-1.5">
              {/* Decorative: the word beside it says it is live. */}
              <span
                aria-hidden="true"
                className="size-1.5 shrink-0 animate-pulse rounded-full bg-emerald-500"
              />
              {voiceLine(voice)}
            </span>
          ) : (
            voiceLine(voice)
          )}
        </ItemDescription>
        {/* Still listening, but the browser hands back no words for what it hears. */}
        {listening && voice.reason ? (
          <ItemDescription className="line-clamp-none">
            {voice.reason}
          </ItemDescription>
        ) : null}
        {listening && voice.heard ? (
          <ItemDescription className="text-foreground" aria-live="polite">
            {`“${voice.heard}”`}
          </ItemDescription>
        ) : null}
      </ItemContent>
      {actions ? (
        <ItemActions>
          {/* Binary and immediate: the microphone opens or closes when switched. */}
          <Switch
            aria-label="Voice"
            checked={on}
            onCheckedChange={(checked) => actions.onMute(!checked)}
          />
        </ItemActions>
      ) : null}
      {actions && voice.problem === "microphone" ? (
        <ItemFooter className="justify-end">
          <Button size="sm" variant="ghost" onClick={actions.onAllowMicrophone}>
            Allow microphone
          </Button>
        </ItemFooter>
      ) : null}
      {actions?.onDownload &&
      voice.problem === "speech-pack" &&
      voice.language ? (
        <ItemFooter className="justify-end">
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              voice.language && actions.onDownload?.(voice.language)
            }
          >
            Download
          </Button>
        </ItemFooter>
      ) : null}
    </Item>
  );
}

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
