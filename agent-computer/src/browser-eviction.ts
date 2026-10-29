/**
 * Which Bots' browsers to close, and when, and which of a Bot's tabs.
 *
 * Its own file, with no Playwright import, for the reason `authorisation.ts` and `bot-id.ts` are:
 * `profiles.ts` imports Playwright at module scope, so anything living there needs a browser merely
 * to be imported by a test. A decision this size should be testable without one, and `profiles.ts`
 * owns the launching, so a test that went through it would be testing Playwright rather than the
 * choice being made.
 *
 * The choice is worth testing on its own. There was no cap and no timeout: a context was started the
 * first time each Bot was used and kept, and the only things that dropped one were an explicit stop,
 * a browser that had already died, and shutdown. A deployment where every employee has a Bot trends
 * toward one resident Chromium per employee in a single container, at a few hundred MB each, until
 * it is killed for memory and relaunches its way back to the same state.
 *
 * Closing one loses nothing. The profile is on disk, so the Bot's logins survive and its next request
 * starts where it left off, which is already what `stop` means here.
 */

import {
  type BrowserWindow,
  isPersonBrowserId,
} from "../../shared/openbot-browser";

/** Enough of a live entry for either decision. Keeps this file independent of what else is on one. */
export type Evictable = { usedAt: number };

/**
 * Which browsers the idle sweep leaves alone and the cap closes last, from where people's browsers show here.
 *
 * A NATIVE WINDOW, AND ONLY A NATIVE WINDOW. A person browsing in a window on their own desktop (OpenBot Desktop) sends
 * this process nothing, so nothing here can tell them from a person who walked away, and their browser always looks
 * like the one used longest ago: by use alone it would be closed out from under them. A cloud browser is different.
 * The person reaches it only through OpenBot's Browser page, which asks for its state every second and streams its
 * screen, and every one of those touches it; once nobody is on that page it is a root, sandbox-less Chromium nobody
 * can see. So it closes when idle, by the Bots' own rule and timeout, and is ranked by use alongside theirs rather
 * than ahead of them. Closing it loses nothing but the open tabs: its profile is on disk and the next open starts
 * from it, as a Bot's does.
 */
export function keptOpen(window: BrowserWindow): (botId: string) => boolean {
  return window === "native" ? isPersonBrowserId : () => false;
}

/**
 * Which to close because there are too many running.
 *
 * Least recently used first: the Bot that has been quiet longest. Applied after a launch, so the Bot
 * that just asked is the most recently used and is therefore never the one closed.
 *
 * A person's native window (`keptOpen`) counts toward the cap like any other and goes last. It is in
 * use whenever the person is in front of it, which this process cannot see: browsing in a native
 * window sends it nothing, so its last use would read as long ago and it would be the first closed,
 * out from under the person, to make room for a Bot. So every Bot's browser is closed before it, and
 * it goes only when nothing else is left to close. A person's cloud browser is ranked by use like a
 * Bot's. The browser that just launched stays either way, whoever it belongs to.
 */
export function chooseEvictions(
  running: Iterable<[string, Evictable]>,
  max: number,
  goesLast: (botId: string) => boolean = () => false,
): string[] {
  const entries = [...running];
  if (entries.length <= max) return [];
  // A cap of zero keeps nothing, the newest included; that is the mistake reading the setting guards.
  const newest = max > 0 ? newestOf(entries) : undefined;

  return inClosingOrder(entries, newest, goesLast)
    .slice(0, entries.length - max)
    .map(([botId]) => botId);
}

/** The most recently used, which is the one a launch has just added. Ties go to the later entry. */
function newestOf(
  entries: [string, Evictable][],
): [string, Evictable] | undefined {
  if (entries.length === 0) return undefined;
  return entries.reduce((latest, entry) =>
    entry[1].usedAt >= latest[1].usedAt ? entry : latest,
  );
}

/**
 * The order browsers are closed in when some have to go: every Bot's before a person's native window
 * (`keptOpen`), and least recently used first within each. `spare` is left out, which is the newest.
 */
function inClosingOrder(
  entries: [string, Evictable][],
  spare: [string, Evictable] | undefined,
  goesLast: (botId: string) => boolean,
): [string, Evictable][] {
  return entries
    .filter((entry) => entry !== spare)
    .sort(
      ([aId, a], [bId, b]) =>
        Number(goesLast(aId)) - Number(goesLast(bId)) || a.usedAt - b.usedAt,
    );
}

/**
 * Which to close next because the computer's memory runs high (`container-memory.ts`).
 *
 * One at a time, because the caller reads memory again after each close and stops as soon as it is
 * enough: a count says in advance how many have to go, and bytes do not.
 *
 * The cap's order, so the two never disagree about who goes first: least recently used, with a
 * person's native window last. And the cap's protection: the newest is never chosen. Before a
 * launch the caller counts the Bot that is asking as the newest, so the browser being launched is
 * never what makes room for itself; on the idle sweep the newest is whoever was used last. Either
 * way at least one browser is always left, because one browser that is on its own too big for the
 * computer is the limit's problem, and closing it would only start it again on the next request.
 *
 * Never one `spared` names, which is a Bot whose wheel a person holds or has been asked to take.
 * Closing that browser closes it under somebody's hands, or under a page the Bot is waiting for
 * somebody to come and work, and memory pressure is not a reason to do either.
 */
export function chooseForMemory(
  running: Iterable<[string, Evictable]>,
  goesLast: (botId: string) => boolean = () => false,
  spared: (botId: string) => boolean = () => false,
): string | undefined {
  const entries = [...running];
  return inClosingOrder(entries, newestOf(entries), goesLast)
    .map(([botId]) => botId)
    .find((botId) => !spared(botId));
}

/**
 * Which to close because nothing has touched them.
 *
 * The other half of the answer: a deployment under the cap still holds a browser for a Bot used once
 * last Tuesday, and that memory is doing nothing for anybody. A timeout of zero or less switches this
 * off, so a deployment can keep browsers resident if it would rather.
 *
 * Never a browser `stays` names, which is a person's native window (`keptOpen`). A person using
 * their browser in a native window sends this process nothing, so nothing here can tell that from a
 * person who walked away, and closing it would close the window they are typing in. It stays open
 * until they close it.
 */
export function chooseIdle(
  running: Iterable<[string, Evictable]>,
  idleTimeoutMs: number,
  now: number,
  stays: (botId: string) => boolean = () => false,
): string[] {
  if (idleTimeoutMs <= 0) return [];
  const cutoff = now - idleTimeoutMs;

  return [...running]
    .filter(([botId, entry]) => entry.usedAt <= cutoff && !stays(botId))
    .map(([botId]) => botId);
}

/** Enough of a tab for the choice. Keeps this file independent of what else is on a page. */
export type IdleTab = {
  /** When the Bot or a person last acted on it, it navigated, or it was the page in front. */
  usedAt: number;
  /** The page the Bot is on, which is the one the live screen shows and its next action lands in. */
  front: boolean;
  /** A page that is never the Bot's to lose: an extension's own (the Recorder's) or DevTools. */
  kept?: boolean;
};

/**
 * Which of a Bot's background tabs to close because nothing has touched them.
 *
 * A Bot is always on its newest page (`chooseLivePage`): a window a site opens is where its work
 * went, and it has no way back to an older tab except that newer ones close. So a tab left behind
 * (the page a sign-in popup was opened from, a link that opened in a new tab and was never closed)
 * holds a renderer and its memory for nothing, for as long as the browser stays up. Closed past a
 * timeout rather than at once, because an opener whose popup is still mid sign-in is waiting for
 * that popup to come back to it.
 *
 * Never the page in front, which is the one the Bot is on, so closing tabs never moves it: it stays
 * the newest open page, which is what the Bot follows. And never anything when which page is in
 * front is not exactly one, because then any tab could be the one the Bot is on. That also means the
 * last tab is never closed, since a single tab is the one in front. A timeout of zero or less
 * switches this off.
 */
export function chooseIdleTabs<T extends IdleTab>(
  tabs: readonly T[],
  idleTimeoutMs: number,
  now: number,
): T[] {
  if (idleTimeoutMs <= 0) return [];
  if (tabs.filter((tab) => tab.front).length !== 1) return [];
  const cutoff = now - idleTimeoutMs;
  return tabs.filter((tab) => !tab.front && !tab.kept && tab.usedAt <= cutoff);
}
