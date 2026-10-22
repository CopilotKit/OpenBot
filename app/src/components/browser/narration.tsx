import type { LauncherState } from "@openbot/shared/openbot-browser";
import { IconMicrophone, IconMicrophoneOff } from "@tabler/icons-react";
import { useId } from "react";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Switch } from "@/components/ui/switch";
import type { NarrationProblem } from "@/lib/browser/narration";
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
    case "not-allowed":
      return `OpenBot can't use your microphone, so narration is off. Allow the microphone for this site, then turn narration on again. ${GOES_ON}`;
    case "no-microphone":
      return `No microphone was found, or another app is using it. ${GOES_ON}`;
    case "service":
      return `This browser's speech recognition is off or unavailable, so narration is off. ${GOES_ON}`;
    case "language":
      return `This browser can't turn ${languageName(language)} speech into text, so narration is off. ${GOES_ON}`;
    case "network":
      return "Can't reach this browser's speech service. Narration tries again in a moment.";
  }
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

/**
 * The narration row on OpenBot Desktop. The Recorder in the person's own browser hears their microphone itself, so
 * there is nothing to switch here: the row says what the Recorder reports, read every second with the rest of the
 * browser's state, so a microphone that is muted or cannot be heard shows here while the person records.
 */
export function NativeNarrationRow({
  voice,
}: {
  voice: LauncherState["voice"];
}) {
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
 * off stops listening after the phrase being said, on listens again (and tries again after a failure).
 */
export function NarrationSwitch({
  narration,
}: {
  narration: NarrationControls;
}) {
  const id = useId();
  const labelId = useId();
  if (!narration.supported) return null;
  const on = !narration.muted;
  const Icon = on ? IconMicrophone : IconMicrophoneOff;
  return (
    <span className="flex shrink-0 items-center gap-2 text-sm">
      <Icon aria-hidden="true" className="size-4 text-muted-foreground" />
      <label htmlFor={id} id={labelId} className="text-muted-foreground">
        Narration
      </label>
      {/* Named by the label's id as well: the switch is a span with role="switch", which `htmlFor` cannot name. */}
      <Switch
        aria-labelledby={labelId}
        id={id}
        checked={on}
        onCheckedChange={(checked) => narration.setMuted(!checked)}
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
  const sentence = !narration.supported
    ? narrationProblemSentence("unsupported", language)
    : narration.status?.state === "failed"
      ? narrationProblemSentence(narration.status.problem, language)
      : narration.lost
        ? lostNarrationSentence(narration.lost.error)
        : null;
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
