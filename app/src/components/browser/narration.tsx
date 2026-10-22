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

/**
 * The narration row on OpenBot Desktop. The Recorder in the person's own browser hears their microphone itself, so
 * there is nothing to switch here: the row only says so.
 */
export function NativeNarrationRow() {
  return (
    <Item size="sm">
      <ItemMedia variant="icon">
        <IconMicrophone />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>Narration</ItemTitle>
        <ItemDescription className="line-clamp-none">
          On. The Recorder hears your microphone while you record, so say what
          you're doing as you go.
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
  if (!narration.supported) return null;
  const on = !narration.muted;
  const Icon = on ? IconMicrophone : IconMicrophoneOff;
  return (
    <span className="flex shrink-0 items-center gap-2 text-sm">
      <Icon aria-hidden="true" className="size-4 text-muted-foreground" />
      <label htmlFor={id} className="text-muted-foreground">
        Narration
      </label>
      <Switch
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
      : narration.lostPhrase
        ? "Some of what you said didn't reach the Recorder. Recording still works."
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
