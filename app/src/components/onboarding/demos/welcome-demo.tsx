import { IconArrowUp, IconMicrophone, IconPlus } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { BotOrb } from "@/components/agents/orb/bot-orb";
import { cn } from "@/lib/utils";
import { DemoStage } from "../demo-stage";

/** The request the composer types, a thing somebody would really hand off. */
export const WELCOME_REQUEST =
  "Find somewhere near the office for a team dinner on Friday, for eight.";

/** How long each character takes to land. Linear: a typewriter that eases reads as hesitating. */
const CHARACTER_MS = 38;

/**
 * Types `text` in while `active`, one character at a time, starting again each time it turns on.
 * Off, or with nothing moving, it is the whole text at once.
 */
function useTyped(text: string, active: boolean): string {
  const [shown, setShown] = useState(active ? 0 : text.length);
  useEffect(() => {
    if (!active) {
      setShown(text.length);
      return;
    }
    setShown(0);
    const timer = setInterval(
      () =>
        setShown((count) => {
          if (count >= text.length) {
            clearInterval(timer);
            return count;
          }
          return count + 1;
        }),
      CHARACTER_MS,
    );
    return () => clearInterval(timer);
  }, [text, active]);
  return text.slice(0, shown);
}

/**
 * Welcome's picture: OpenBot's orb listening while a request is typed, then working on it.
 *
 * A DRAWING OF THE COMPOSER, NOT THE COMPOSER. The real one reads its text once, when it mounts,
 * so it cannot be typed into from outside; and a live editor in a picture would be one more thing
 * to tab to. This is its outline: the same card, the same buttons, and the words arriving.
 *
 * Three beats: typing, handed off and working, done. With reduced motion it is the typed request
 * with the orb listening.
 */
export function WelcomeDemo() {
  return (
    <DemoStage
      beats={3}
      className="flex min-w-0 flex-col items-center gap-8 px-5 pt-12 pb-8 sm:px-8"
      kind="welcome"
      label={`A message box where somebody asks a Bot: ${WELCOME_REQUEST}`}
      rest={0}
    >
      {({ beat, playing, reduced }) => (
        <WelcomeScene beat={beat} playing={playing} reduced={reduced} />
      )}
    </DemoStage>
  );
}

function WelcomeScene({
  beat,
  playing,
  reduced,
}: {
  beat: number;
  playing: boolean;
  reduced: boolean;
}) {
  const typing = beat === 0;
  const typed = useTyped(WELCOME_REQUEST, typing && playing);
  const sent = !typing;
  const state = typing ? "listening" : beat === 1 ? "thinking" : "done";
  return (
    <>
      <BotOrb
        size={72}
        state={reduced ? "listening" : state}
        still={!playing}
      />
      <div className="w-full max-w-md">
        <div className="flex min-h-[7.5rem] flex-col justify-between gap-3 rounded-2xl bg-card p-3 shadow-(--shadow-card)">
          <p
            className={cn(
              "type-sub min-h-10 px-1 pt-1 text-left transition-opacity duration-300",
              sent && !reduced ? "text-muted-foreground" : "text-foreground",
            )}
          >
            {sent && !reduced ? WELCOME_REQUEST : typed}
            {typing && playing ? (
              <span
                aria-hidden
                className="ml-px inline-block h-4 w-px translate-y-0.5 bg-foreground"
              />
            ) : null}
          </p>
          <div className="flex items-center justify-between">
            <span className="grid size-8 place-items-center rounded-full text-muted-foreground">
              <IconPlus className="size-4" />
            </span>
            <div className="flex items-center gap-1.5">
              <span className="grid size-8 place-items-center rounded-full text-muted-foreground">
                <IconMicrophone className="size-4" />
              </span>
              <span
                className={cn(
                  "grid size-8 place-items-center rounded-full transition-colors duration-300",
                  typed.length > 0 || sent
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground",
                )}
              >
                <IconArrowUp className="size-4" />
              </span>
            </div>
          </div>
        </div>
        <p
          className={cn(
            "type-caption mt-3 flex h-4 items-center justify-center gap-1.5 transition-opacity duration-300",
            sent ? "opacity-100" : "opacity-0",
          )}
        >
          <span
            aria-hidden
            className={cn(
              "size-1.5 rounded-full",
              beat === 2 ? "bg-status-done" : "bg-status-working",
            )}
          />
          <span
            className={beat === 2 ? "text-status-done" : "text-status-working"}
          >
            {beat === 2 ? "Found three places" : "Working on it"}
          </span>
        </p>
      </div>
    </>
  );
}
