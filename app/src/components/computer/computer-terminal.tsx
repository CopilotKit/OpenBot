import { useRef, useState } from "react";
import { useComputerControl } from "@/lib/computers/use-control";
import { ComputerControlButton } from "./computer-controls";
import { LiveTerminal, type LiveTerminalHandle } from "./live-terminal";
import { TERMINAL_BACKGROUND } from "./terminal-theme";

/**
 * The Computer panel's Terminal tab: the Bot's live shell, and the wheel under it.
 *
 * Drawn as the screen's card is (computer-view.tsx): the same rounded frame and border, and the same
 * row beneath it saying who has control, with the same Take control and Hand back. It is the same
 * wheel. Taking it here takes the whole computer, as it does from the screen, and the Bot waits until
 * it is handed back. The terminal inside is always a dark terminal, in either of the app's themes.
 */
export function ComputerTerminal({ computerId }: { computerId: string }) {
  const { control, someoneElse } = useComputerControl(computerId);
  /** The signed-in person holds the wheel. Someone else holding it on a shared Bot is not them typing. */
  const driving =
    control?.holder === "human" && !control.transitioning && !someoneElse;
  const terminal = useRef<LiveTerminalHandle>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [retryKey, setRetryKey] = useState(0);

  return (
    <figure className="overflow-hidden rounded-2xl border dark:border-white/15">
      <div
        className="relative h-[clamp(16rem,55vh,30rem)] p-2.5"
        style={{ background: TERMINAL_BACKGROUND }}
      >
        <LiveTerminal
          computerId={computerId}
          driving={driving}
          onProblem={setProblem}
          onReconnecting={setReconnecting}
          ref={terminal}
          retryKey={retryKey}
        />
        {reconnecting && !problem ? (
          <span
            className="absolute top-2 right-2 rounded-full bg-black/60 px-2.5 py-1 font-medium text-white text-xs backdrop-blur-sm"
            role="status"
          >
            Reconnecting…
          </span>
        ) : null}
        {problem ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background/90 p-4 text-center text-muted-foreground text-sm">
            <span>{problem}</span>
            <button
              className="underline"
              onClick={() => {
                setProblem(null);
                setRetryKey((value) => value + 1);
              }}
              type="button"
            >
              Retry
            </button>
          </div>
        ) : null}
      </div>
      <div
        className={`flex flex-wrap items-center justify-between gap-2 border-t px-3 py-2 ${driving ? "bg-amber-500/10" : ""}`}
      >
        {driving ? (
          <span className="text-sm">
            <strong className="font-medium">You have control</strong> of the
            terminal and the screen. Click the terminal and type. The Bot waits
            until you hand it back.
          </span>
        ) : (
          <span className="text-muted-foreground text-xs">
            {!control
              ? "Checking who has control…"
              : control.transitioning
                ? "Finishing the current action…"
                : someoneElse
                  ? "Someone else has control."
                  : "The Bot has control."}
          </span>
        )}
        <ComputerControlButton
          computerId={computerId}
          onTakeControl={() => terminal.current?.focus()}
        />
      </div>
    </figure>
  );
}
