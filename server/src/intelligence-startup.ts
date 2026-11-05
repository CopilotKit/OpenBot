/**
 * Asking Intelligence something at boot, while Intelligence may still be starting.
 *
 * Installed together from OpenBot's Helm chart, OpenBot's server is up before Intelligence can
 * answer, by design. Helm runs Intelligence's migrations (post-install, weight 5) and then its
 * bootstrap (weight 10), which stores this deployment's runtime key and creates the `openbot`
 * Learning container, only once every Deployment in the release is ready, OpenBot's included. Until
 * both have run, Intelligence refuses connections, then answers 500 (`relation ... does not exist`),
 * then 401 (the key is not stored yet). A question asked once at boot gets one of those, and the
 * operator is told about a problem that is gone a few seconds later.
 *
 * So a boot-time question is asked again, with backoff, while its answer says Intelligence is still
 * starting, for as long as an install can take; only an answer still in that state at the end is
 * reported as one. Ten minutes is twice Helm's own default `--timeout`: an install that has not
 * finished by then has failed on its own account.
 */
export const INTELLIGENCE_STARTUP_WINDOW_MS = 10 * 60_000;
const FIRST_DELAY_MS = 2_000;
const MAX_DELAY_MS = 15_000;

/** The clock a startup wait runs on. Tests pass their own; the server uses the real one. */
export type StartupClock = {
  windowMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

function sleepUnref(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // Never keep the process alive for this alone.
    (timer as { unref?: () => void }).unref?.();
  });
}

/**
 * Ask, and keep asking while `starting` says the answer is Intelligence still starting, until the
 * window closes. Returns the last answer, whatever it is: the caller reports it. `onWaiting` hears
 * the first starting answer, once, so a caller can say it is waiting without saying it every time.
 */
export async function askWhileIntelligenceStarts<T>(
  ask: () => Promise<T>,
  starting: (answer: T) => boolean,
  options: StartupClock & { onWaiting?: (answer: T) => void } = {},
): Promise<T> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? sleepUnref;
  const deadline = now() + (options.windowMs ?? INTELLIGENCE_STARTUP_WINDOW_MS);
  let delay = FIRST_DELAY_MS;
  let answer = await ask();
  let waiting = false;
  while (starting(answer) && now() < deadline) {
    if (!waiting) {
      waiting = true;
      options.onWaiting?.(answer);
    }
    await sleep(Math.min(delay, Math.max(0, deadline - now())));
    delay = Math.min(delay * 2, MAX_DELAY_MS);
    answer = await ask();
  }
  return answer;
}

/** An HTTP status a request may get past unchanged in a moment: the runtime client's own rule. */
export function transientStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}
