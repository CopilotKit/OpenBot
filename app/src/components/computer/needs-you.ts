import { useEffect, useState } from "react";
import { readControl } from "@/lib/computers/control";

/**
 * Poll closed screens for control/secret prompts so blocked Bots can surface outside the screen.
 */

const INTERVAL_MS = 3_000;

export function useNeedsYou(botId: string | undefined, when: boolean): boolean {
  const [needed, setNeeded] = useState(false);

  useEffect(() => {
    if (!botId || !when) {
      setNeeded(false);
      return;
    }

    let live = true;
    const check = async () => {
      const state = await readControl(botId).catch(() => null);
      if (!live) return;
      setNeeded(
        Boolean(state && (state.requested || state.secretWanted !== undefined)),
      );
    };

    void check();
    const timer = setInterval(() => void check(), INTERVAL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [botId, when]);

  return needed;
}
