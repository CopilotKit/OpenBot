import type { LauncherState } from "@openbot/shared/openbot-browser";
import { IconMicrophone, IconMicrophoneOff } from "@tabler/icons-react";
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
import type { NarrationProblem } from "@/lib/browser/narration";
import type { NarrationChoice } from "./narration-choice";
import type { NarrationControls } from "./use-narration";

const GOES_ON = "Recording still works.";

function languageName(language: string): string {
  try {
    return (
      new Intl.DisplayNames(["en"], { type: "language" }).of(language) ??
      language
    );
  } catch {
    return language;
  }
}

/** What the person is told when narration did not reach the Recorder: the server's own sentence for why, when it said
 * one, since that is what they can act on. */
function lostNarrationSentence(error: string | null): string {
  return error
    ? `Some of what you said didn't reach the Recorder. ${error}`
    : `Some of what you said didn't reach the Recorder. ${GOES_ON}`;
}

/** Why narration is off, and what the person can do about it, in one or two short sentences. */
export function narrationProblemSentence(
  problem: NarrationProblem,
  language: string,
): string {
  switch (problem) {
    case "unsupported":
      return `Narration isn't available in this browser, so what you say isn't recorded. ${GOES_ON}`;
    case "on-device":
      return `This browser can't turn speech into text on your computer, and OpenBot sends your voice nowhere else, so narration is off. ${GOES_ON}`;
    case "speech-pack":
      return `Your browser has to download its ${languageName(language)} speech recognition to your computer first. Turn narration on to download it. ${GOES_ON}`;
    case "not-allowed":
      return `OpenBot can't use your microphone, so narration is off. Allow the microphone for this site, then turn narration on again. ${GOES_ON}`;
    case "no-microphone":
      return `No microphone was found, or another app is using it. ${GOES_ON}`;
    case "service":
      return `This browser's speech recognition is off or unavailable, so narration is off. ${GOES_ON}`;
    case "language":
      return `This browser can't turn ${languageName(language)} speech into text on your computer, so narration is off. ${GOES_ON}`;
    case "network":
      return "Can't reach this browser's speech service. Narration tries again in a moment.";
  }
}

/** What the person is told while their browser downloads the narration's language: narration starts by itself. */
export function downloadingSentence(language: string): string {
  return `Your browser is downloading its ${languageName(language)} speech recognition to your computer. Narration starts when it's ready.`;
}

/** What the Desktop narration row says, from the Recorder's own report of whether it hears the person. */
function nativeNarrationSentence(voice: LauncherState["voice"]): string {
  switch (voice) {
    case "listening":
      return "Listening. Say what you're doing as you go.";
    case "muted":
      return "Muted in the Recorder, so what you say isn't recorded. Turn it on again from the Recorder's button in your browser's toolbar.";
    case "unavailable":
      return `The Recorder can't hear your microphone, so what you say isn't recorded. The Recorder's button in your browser's toolbar says why. ${GOES_ON}`;
    // Nothing is being recorded yet, or the Recorder has not said.
    default:
      return "On. The Recorder hears your microphone while you record, so say what you're doing as you go.";
  }
}

/** The narration row on OpenBot Desktop while nothing records: the person's choice, which the next Record passes on. */
function narrationChoiceSentence(
  narration: Exclude<NarrationChoice["narration"], undefined>,
) {
  switch (narration) {
    case "on":
      return "On. The Recorder in your browser listens to your microphone while you record, and turns your speech into text on your computer.";
    case "off":
      return "Off. The Recorder doesn't open your microphone.";
    case null:
      return "Not chosen yet. Record asks before your first recording, and the microphone stays closed until you say yes.";
  }
}

/**
 * The narration row on OpenBot Desktop. While nothing records it is the person's choice, a switch that takes effect at
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
  if (!recording) {
    const on = choice.narration === "on";
    // Not known yet (the preferences still loading, or unreadable): nothing said, and nothing to switch.
    const known = choice.narration !== undefined;
    return (
      <Item size="sm">
        <ItemMedia variant="icon">
          {on ? <IconMicrophone /> : <IconMicrophoneOff />}
        </ItemMedia>
        <ItemContent>
          <ItemTitle>Narration</ItemTitle>
          {choice.narration !== undefined ? (
            <ItemDescription className="line-clamp-none">
              {narrationChoiceSentence(choice.narration)}
            </ItemDescription>
          ) : null}
        </ItemContent>
        <ItemActions>
          <Switch
            aria-label="Narration"
            checked={on}
            disabled={!known}
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
          ) : (
            nativeNarrationSentence(voice)
          )}
        </ItemDescription>
      </ItemContent>
    </Item>
  );
}

/**
 * Narration on and off, for the bar above a browser shown in the page. A switch, because it takes effect at once:
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
    <span className="flex shrink-0 items-center gap-2 text-sm">
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
      {/* Named by the label's id as well: the switch is a span with role="switch", which `htmlFor` cannot name. */}
      <Switch
        aria-labelledby={labelId}
        id={id}
        checked={on}
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
}: {
  narration: NarrationControls;
  language: string;
}) {
  const sentence = narrationNoticeSentence(narration, language);
  if (!sentence) return null;
  return (
    <p
      className="border-b border-border bg-muted/40 px-3 py-2 text-muted-foreground text-sm"
      role="status"
    >
      {sentence}
    </p>
  );
}

/**
 * What the person needs to know about narration, or null when it is simply on or off as they set it. `lost` is whether
 * to say that some of it did not reach the Recorder.
 */
function narrationNoticeSentence(
  narration: NarrationControls,
  language: string,
  lost = true,
): string | null {
  return !narration.supported
    ? narrationProblemSentence("unsupported", language)
    : narration.status?.state === "failed"
      ? narrationProblemSentence(narration.status.problem, language)
      : narration.status?.state === "downloading"
        ? downloadingSentence(language)
        : lost && narration.lost
          ? lostNarrationSentence(narration.lost.error)
          : null;
}

/**
 * Narration as a row, for a card of rows under a browser shown in the page (a Bot's screen): the same switch, the same
 * choice and the same sentences as the bar above the person's own browser, laid out as every other setting is. The row
 * always says what narration does, so a person deciding whether to talk knows before Record whether it is heard, and
 * how; and while the page hears them it says Listening, so an open microphone is never something to guess at.
 *
 * `choice` is the person's preference (`useNarrationChoice`), null until they answered the question Record asks first.
 * `onChange` keeps a new one, as the bar's switch does.
 *
 * `recording` is whether the person's recording is running. Narration that did not reach the Recorder is news only
 * then: a phrase cut off as the wheel went back was refused because the recording had already ended, which the
 * recording's own row says, and the row must not still be saying it when they take the wheel again.
 */
export function NarrationRow({
  narration,
  choice,
  language,
  recording,
  onChange,
}: {
  narration: NarrationControls;
  choice: NarrationChoice["narration"];
  language: string;
  recording: boolean;
  onChange: (on: boolean) => void;
}) {
  const labelId = useId();
  const notice = narrationNoticeSentence(narration, language, recording);
  const listening =
    !notice && recording && narration.status?.state === "listening";
  const sentence =
    notice ??
    (listening
      ? "Listening. Say what you're doing as you go."
      : narration.on
        ? "On. OpenBot hears your microphone while you record and turns your speech into text on your computer, so say what you're doing as you go."
        : choice === null
          ? "Not chosen yet. Record asks before your first recording, and the microphone stays closed until you say yes."
          : "Off. What you say isn't recorded.");
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
            onCheckedChange={onChange}
          />
        </ItemActions>
      ) : null}
    </Item>
  );
}
