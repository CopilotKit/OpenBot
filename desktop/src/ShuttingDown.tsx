import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { type Progress, SetupProgress } from "./SetupProgress";

/**
 * The Shutting down screen's rows, as `quit:progress` carries them: the whole list each time, with
 * a sequence that only rises, so whichever copy is newest wins.
 */
export type QuitStatus = { seq: number; steps: Progress[] };

/** The setup page's fragment that the native side opens to show this screen alone. */
const SHUTTING_DOWN_HASH = "#shutting-down";

export function isShuttingDownPage(hash: string): boolean {
  return hash === SHUTTING_DOWN_HASH;
}

/**
 * The rows of a Quit in progress, or null while nobody has quit.
 *
 * `catchUp` also asks for the rows sent before this page loaded, for a window the native side
 * navigated here once the cleanup had already begun.
 */
export function useQuitStatus(catchUp: boolean): QuitStatus | null {
  const [status, setStatus] = useState<QuitStatus | null>(null);
  useEffect(() => {
    let active = true;
    const keep = (next: QuitStatus | null) => {
      if (!active || !next) return;
      setStatus((current) =>
        current && current.seq >= next.seq ? current : next,
      );
    };
    const stop = listen<QuitStatus>("quit:progress", (event) =>
      keep(event.payload),
    );
    if (catchUp) {
      stop
        .then(() => invoke<QuitStatus | null>("quit_status"))
        .then(keep)
        // The rows still arrive as events; the screen does not depend on this answer.
        .catch(() => {});
    }
    return () => {
      active = false;
      stop.then((unlisten) => unlisten());
    };
  }, [catchUp]);
  return status;
}

/** What the person sees between choosing Quit and the app closing. Nothing to press. */
export function ShuttingDown({ status }: { status: QuitStatus | null }) {
  const steps = status?.steps ?? [];
  const failed = steps.some((step) => !step.ok);
  return (
    <main>
      <div className="sheet connection-sheet">
        <h1>Shutting down OpenBot</h1>
        <p className="lede" role="status">
          {failed
            ? "Part of it could not be stopped. OpenBot says what happened the next time it opens."
            : "OpenBot is stopping what it started on this computer, then it closes."}
        </p>
        <SetupProgress steps={steps} label="Shutdown progress" />
      </div>
    </main>
  );
}

/** The whole window when the native side opened the setup page on this screen. */
export function ShuttingDownWindow() {
  return <ShuttingDown status={useQuitStatus(true)} />;
}
