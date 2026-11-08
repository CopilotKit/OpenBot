import type { LauncherState } from "@openbot/shared/openbot-browser";
import {
  IconInfoCircle,
  IconMicrophone,
  IconMicrophoneOff,
} from "@tabler/icons-react";
import { useId } from "react";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { NarrationProblem } from "@/lib/browser/narration";
import { cn } from "@/lib/utils";
import type { NarrationChoice } from "./narration-choice";
import { useMicrophone } from "./use-microphone";
import type { NarrationControls } from "./use-narration";

/**
 * All narration ever says (David): it is on and capturing the voice, or it is off. Capturing is said only while a
 * recording runs and narration hears the person; on with nothing to capture yet (before Record, or while it starts),
 * it says only that it is on.
 */
export const NARRATION_CAPTURING =
  "Narration is on. We're capturing your voice.";
export const NARRATION_ON = "Narration is on.";
export const NARRATION_OFF = "Narration is off.";
/** What narration is for, beside its switch in Record's popover. */
export const NARRATION_EXPLAINED =
  "Talk out loud while you do the task to explain your thinking. What you say becomes part of what your Bots learn.";
/** Said wherever narration is, on a computer with no microphone: before a recording too, so nobody narrates to nothing. */
export const NARRATION_NO_MICROPHONE = "No microphone found. Narration is off.";

/** Narration that cannot hear the person is simply off. */
export function narrationProblemSentence(
  _problem: NarrationProblem,
  _language: string,
): string {
  return NARRATION_OFF;
}

/** What the person is told while their browser downloads the narration's language: narration starts by itself. */
export function downloadingSentence(_language: string): string {
  return NARRATION_OFF;
}

/** What the Desktop narration row says while a recording runs, from the Recorder's own report of whether it hears the person. */
function nativeNarrationSentence(voice: LauncherState["voice"]): string {
  if (voice === "listening") return NARRATION_CAPTURING;
  return voice === "muted" || voice === "unavailable"
    ? NARRATION_OFF
    : NARRATION_ON;
}

/**
 * The narration row for a window on the person's desktop. While nothing records it is the person's choice, a switch that takes effect at
 * once: the next Record tells the Recorder in their browser whether to open the microphone. While a recording runs, the
 * Recorder hears the microphone itself, so the row says what it reports, read every second with the rest of the
 * browser's state, so a microphone that is muted or cannot be heard shows here while the person records.
 */
export function NativeNarrationRow({
  voice,
  choice,
  recording,
}: {
  voice: LauncherState["voice"];
  choice: NarrationChoice;
  /** A recording is running (or starting, or stopping). */
  recording: boolean;
}) {
  // No microphone on this computer: off, and said, while the person's choice stays as they made it.
  const noMicrophone = useMicrophone() === false;
  if (!recording) {
    const on = choice.narration === "on" && !noMicrophone;
    // Not known yet (the preferences still loading, or unreadable): nothing said, and nothing to switch.
    const known = choice.narration !== undefined;
    return (
      <Item size="sm">
        <ItemMedia variant="icon">
          {on ? <IconMicrophone /> : <IconMicrophoneOff />}
        </ItemMedia>
        <ItemContent>
          <ItemTitle>Narration</ItemTitle>
          <ItemDescription className="line-clamp-none">
            {noMicrophone
              ? NARRATION_NO_MICROPHONE
              : on
                ? NARRATION_ON
                : NARRATION_OFF}
          </ItemDescription>
        </ItemContent>
        <ItemActions>
          <Switch
            aria-label="Narration"
            checked={on}
            disabled={!known || noMicrophone}
            onCheckedChange={choice.choose}
          />
        </ItemActions>
      </Item>
    );
  }
  const hearing = voice !== "muted" && voice !== "unavailable";
  return (
    <Item size="sm">
      <ItemMedia variant="icon">
        {hearing ? <IconMicrophone /> : <IconMicrophoneOff />}
      </ItemMedia>
      <ItemContent>
        <ItemTitle>Narration</ItemTitle>
        <ItemDescription className="line-clamp-none">
          {voice === "listening" ? (
            <span className="inline-flex items-center gap-1.5">
              {/* Decorative: the word beside it says it is live. */}
              <span
                aria-hidden="true"
                className="size-1.5 shrink-0 rounded-full bg-emerald-500 motion-safe:animate-pulse"
              />
              {nativeNarrationSentence(voice)}
            </span>
          ) : noMicrophone ? (
            NARRATION_NO_MICROPHONE
          ) : (
            nativeNarrationSentence(voice)
          )}
        </ItemDescription>
      </ItemContent>
    </Item>
  );
}

/**
 * Narration on and off, for a browser shown in the page: in Record's popover, and in the toolbar while a recording
 * runs. A switch, because it takes effect at once:
 * off stops listening after the phrase being said, on listens again (and tries again after a failure). It is the
 * person's choice, so `onChange` keeps it as well. It shows the state narration is in, so a narration that failed reads
 * off, as the notice under the bar says; while a recording runs and the page hears the person, it says Listening beside
 * it, so an open microphone is never something to guess at.
 */
export function NarrationSwitch({
  narration,
  recording,
  onChange,
}: {
  narration: NarrationControls;
  /** A recording is running: the switch says whether the page is listening now. */
  recording: boolean;
  onChange: (on: boolean) => void;
}) {
  const id = useId();
  const labelId = useId();
  if (!narration.supported) return null;
  const on = narration.on;
  const listening = recording && narration.status?.state === "listening";
  const Icon = on ? IconMicrophone : IconMicrophoneOff;
  return (
    // `data-slot` lets Record's popover lay it out as a row of its own, the switch at the row's end.
    <span
      className="flex shrink-0 items-center gap-2 text-sm"
      data-slot="narration-switch"
    >
      {listening ? (
        <span
          className="inline-flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400"
          role="status"
        >
          {/* Decorative: the word beside it says it is live. */}
          <span
            aria-hidden="true"
            className="size-1.5 shrink-0 rounded-full bg-emerald-500 motion-safe:animate-pulse"
          />
          Listening
        </span>
      ) : null}
      <Icon aria-hidden="true" className="size-4 text-muted-foreground" />
      <label htmlFor={id} id={labelId} className="text-muted-foreground">
        Narration
      </label>
      {/*
        What narration is for, on hover or focus, where the choice is made (Record's popover). Not while recording:
        the choice is made by then, and the bar has no room. A button of type "button": in Record's form any other
        would submit it and start the recording.
      */}
      {recording ? null : (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                aria-label="About narration"
                className="-ml-1 flex size-5 items-center justify-center rounded-full text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                type="button"
              />
            }
          >
            <IconInfoCircle aria-hidden="true" className="size-4" />
          </TooltipTrigger>
          <TooltipContent className="max-w-60" side="top">
            {NARRATION_EXPLAINED}
          </TooltipContent>
        </Tooltip>
      )}
      {/* Named by the label's id as well: the switch is a span with role="switch", which `htmlFor` cannot name. */}
      <Switch
        aria-labelledby={labelId}
        className="ml-auto"
        id={id}
        checked={on}
        disabled={narration.noMicrophone}
        onCheckedChange={onChange}
      />
    </span>
  );
}

/**
 * What the person needs to know about narration on a screen, as a line under the bar, or nothing when it is simply on
 * or off as they set it. Shown before a recording too where the browser has no speech recognition at all, so nobody
 * narrates a whole task to find out afterwards.
 */
export function NarrationNotice({
  narration,
  language,
  className,
}: {
  narration: NarrationControls;
  language: string;
  /** Where it is drawn as the browser window's status bar rather than a row under its bar. */
  className?: string;
}) {
  const sentence = narrationNoticeSentence(narration, language);
  if (!sentence) return null;
  return (
    <p
      className={cn(
        "border-b border-border bg-muted/40 px-3 py-2 text-muted-foreground text-sm",
        className,
      )}
      role="status"
    >
      {sentence}
    </p>
  );
}

/**
 * Narration is off when the browser cannot hear the person, or they turned it off. It is capturing only while it hears
 * them, which is only while a recording runs (`useNarration` has no status otherwise); else it is simply on.
 */
function narrationNoticeSentence(
  narration: NarrationControls,
  _language: string,
): string | null {
  if (narration.supported && narration.noMicrophone)
    return NARRATION_NO_MICROPHONE;
  if (
    !narration.supported ||
    !narration.on ||
    narration.status?.state === "failed" ||
    narration.status?.state === "downloading"
  )
    return NARRATION_OFF;
  return narration.status?.state === "listening"
    ? NARRATION_CAPTURING
    : NARRATION_ON;
}

/**
 * Narration as a row, for a card of rows under a browser shown in the page (a Bot's screen): the same switch, the same
 * choice and the same sentences as the bar above the person's own browser, laid out as every other setting is. The row
 * always says what narration does, so a person deciding whether to talk knows before Record whether it is heard, and
 * how; and while the page hears them it says Listening, so an open microphone is never something to guess at.
 *
 * `onChange` keeps the person's new choice, as the bar's switch does.
 *
 * `recording` is whether the person's recording is running. Narration that did not reach the Recorder is news only
 * then: a phrase cut off as the wheel went back was refused because the recording had already ended, which the
 * recording's own row says, and the row must not still be saying it when they take the wheel again.
 */
export function NarrationRow({
  narration,
  language,
  recording,
  onChange,
}: {
  narration: NarrationControls;
  language: string;
  recording: boolean;
  onChange: (on: boolean) => void;
}) {
  const labelId = useId();
  const notice = narrationNoticeSentence(narration, language);
  const listening =
    !notice && recording && narration.status?.state === "listening";
  const sentence =
    notice ??
    (narration.supported && narration.on ? NARRATION_ON : NARRATION_OFF);
  return (
    <Item size="sm">
      <ItemMedia variant="icon">
        {narration.supported && narration.on ? (
          <IconMicrophone />
        ) : (
          <IconMicrophoneOff />
        )}
      </ItemMedia>
      <ItemContent>
        <ItemTitle id={labelId}>Narration</ItemTitle>
        <ItemDescription className="line-clamp-none" role="status">
          {listening ? (
            <span className="inline-flex items-center gap-1.5">
              {/* Decorative: the word beside it says it is live. */}
              <span
                aria-hidden="true"
                className="size-1.5 shrink-0 rounded-full bg-emerald-500 motion-safe:animate-pulse"
              />
              {sentence}
            </span>
          ) : (
            sentence
          )}
        </ItemDescription>
      </ItemContent>
      {narration.supported ? (
        <ItemActions>
          <Switch
            aria-labelledby={labelId}
            checked={narration.on}
            disabled={narration.noMicrophone}
            onCheckedChange={onChange}
          />
        </ItemActions>
      ) : null}
    </Item>
  );
}
