/**
 * Browser-activity epoch used by surfaces that auto-open the live screen once per run.
 */

const QUIET_GAP_MS = 10_000;

type Activity = {
  botId: string;
  /** The run, for surfaces that open once per run and honour a dismissal for the rest of it. */
  epoch: number;
  /**
   * This call, for taking an announcement back.
   *
   * A RUN IS TOO COARSE TO RETRACT. A Bot that opens a page and then has a click refused made both
   * calls in one run; closing on the run would shut a pane that is showing the page the first call
   * loaded. A pane remembers the announcement that opened it, so only that call can close it.
   */
  announcement: number;
};

let epoch = 0;
let announcement = 0;
let lastAt = 0;
let lastBot: string | null = null;
const listeners = new Set<(activity: Activity) => void>();
const withdrawals = new Set<(withdrawal: Withdrawal) => void>();

type Withdrawal = { botId: string; announcement: number };

/**
 * Called wherever a Bot's computer is reached, so auto-open surfaces share one activity source.
 *
 * Returns this call's announcement, which is what a caller hands
 * {@link withdrawComputerActivity} when the action turns out not to have happened.
 */
export function reportComputerActivity(botId: string): number {
  const now = Date.now();
  // A different Bot is always a new run, however recently the last one acted.
  if (botId !== lastBot || now - lastAt > QUIET_GAP_MS) epoch += 1;
  lastAt = now;
  lastBot = botId;
  announcement += 1;
  const activity = { botId, epoch, announcement };
  for (const listener of listeners) listener(activity);
  return announcement;
}

/**
 * Take an announcement back: the action it was made for was refused, so nothing happened.
 *
 * The announcement goes out BEFORE the request, because a page is worth watching while it loads,
 * and that is the whole reason this exists. A refusal arrives after it, by which point a pane has
 * already opened on a screen the Bot never touched.
 */
export function withdrawComputerActivity(
  botId: string,
  forAnnouncement: number,
): void {
  const withdrawal = { botId, announcement: forAnnouncement };
  for (const listener of withdrawals) listener(withdrawal);
}

export function onComputerActivity(
  listener: (activity: Activity) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function onComputerActivityWithdrawn(
  listener: (withdrawal: Withdrawal) => void,
): () => void {
  withdrawals.add(listener);
  return () => {
    withdrawals.delete(listener);
  };
}
