/**
 * Browser-activity epoch used by surfaces that auto-open the live screen once per run.
 */

const QUIET_GAP_MS = 10_000;

type Activity = { botId: string; epoch: number };

let epoch = 0;
let lastAt = 0;
let lastBot: string | null = null;
const listeners = new Set<(activity: Activity) => void>();

/** Called wherever a Bot's computer is reached, so auto-open surfaces share one activity source. */
export function reportComputerActivity(botId: string): void {
  const now = Date.now();
  // A different Bot is always a new run, however recently the last one acted.
  if (botId !== lastBot || now - lastAt > QUIET_GAP_MS) epoch += 1;
  lastAt = now;
  lastBot = botId;
  const activity = { botId, epoch };
  for (const listener of listeners) listener(activity);
}

export function onComputerActivity(
  listener: (activity: Activity) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
