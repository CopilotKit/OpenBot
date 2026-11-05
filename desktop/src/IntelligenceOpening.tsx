import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { StatusLine } from "./SetupProgress";

/** What the menu's "Open Intelligence dashboard" says, in fixed native words. */
type Opening = { state: "opening" | "opened" | "failed"; said: string };

/** How long how it went stays on screen. */
const SHOWN_FOR_MS = 6_000;

/**
 * The menu's dashboard opening, over whichever setup screen is showing.
 *
 * The menu can be chosen while the window shows anything, so this sits apart from every screen
 * rather than in one of them, and never moves what is under it.
 */
export function IntelligenceOpening() {
  const [opening, setOpening] = useState<Opening | null>(null);
  useEffect(() => {
    const stop = listen<Opening>("intelligence:opening", (event) =>
      setOpening(event.payload),
    );
    return () => {
      stop.then((unlisten) => unlisten());
    };
  }, []);
  useEffect(() => {
    if (!opening || opening.state === "opening") return;
    const timer = setTimeout(() => setOpening(null), SHOWN_FOR_MS);
    return () => clearTimeout(timer);
  }, [opening]);
  if (!opening) return null;
  return (
    <div className="window-status">
      <StatusLine working={opening.state === "opening"}>
        {opening.said}
      </StatusLine>
    </div>
  );
}
