/**
 * What a person's browser id may do on this computer.
 *
 * A PERSON'S BROWSER IS THE PERSON'S. It is a computer named for them (`person-` and 32 hex digits),
 * so every existing way of reaching a computer carries it, and that is exactly why the id has to be
 * held to its own list: the routes that act for a Bot (navigate, click, type, run a command, write a
 * file, ask for help, read the page for a model) would otherwise act in a person's own browser, with
 * their logins, for whoever holds the computer token. No Bot acts in it this round, so those are
 * refused for a person's id however the request arrived.
 *
 * It starts with the person holding the wheel. A Bot's computer takes a person's input only after
 * they take control, because the Bot is working in it; nobody else works in a person's browser, so
 * the live screen's input is theirs from the start and the control route says so.
 *
 * Free of Playwright, like `authorisation.ts`, so the list is testable without a browser.
 */
import type { ComputerControlState } from "../../shared/computer-control";
import {
  browserComputerPaths,
  isPersonBrowserId,
  PEOPLE_ONLY_ENV,
  realBrowserComputerPaths,
} from "../../shared/openbot-browser";

/** Why a Bot route is refused for a person's browser id. */
export const PERSONS_OWN_BROWSER =
  "That is a person's own browser. No Bot acts in it.";

/** Why a person's browser route has nothing to act on. */
export const BROWSER_NOT_OPEN = "This browser is not open. Open it first.";

/** Thrown where a person's page is asked for and their browser is not open, which never opens it. */
export class BrowserNotOpenError extends Error {
  constructor() {
    super(BROWSER_NOT_OPEN);
    this.name = "BrowserNotOpenError";
  }
}

const PERSON_PATHS = new Set<string>([
  ...Object.values(browserComputerPaths),
  // The person's own everyday browser, on OpenBot Desktop: brought forward, or shown the
  // Recorder's store page. Nothing in it is read or driven (see real-browser.ts).
  ...Object.values(realBrowserComputerPaths),
  // The live screen, and the person's own input through it.
  "/stream",
  "/human/click",
  "/human/type",
  "/human/key",
  "/human/scroll",
  // Who holds the wheel, which for a person's browser is always the person.
  "/control",
  // The computer's own housekeeping, keyed by id like any other computer's: its network policy,
  // whether it is running, stopping it, and forgetting its profile.
  "/health",
  "/egress-policy",
  "/computers",
  "/computers/stop",
  "/computers/reset",
  "/run",
]);

export function personMayUse(pathname: string): boolean {
  return PERSON_PATHS.has(pathname);
}

/** The control state of a person's browser: theirs, with nothing asked of them. */
export function personHoldsTheWheel(since: string): ComputerControlState {
  return {
    holder: "human",
    since,
    requested: false,
    transitioning: false,
    resumeSnapshotRequired: false,
    recoveryRequired: false,
  };
}

/**
 * Whose this computer is, from how it was started.
 *
 * A PERSON'S BROWSER RUNS ONLY ON A COMPUTER OF ITS OWN. Beside Bots it would share their container, where a Bot may
 * run a shell (`/exec`) as the same user, and its profile holds what the person signed in to by hand: a
 * prompt-injected Bot could read `/profiles/person-<hex>/Default/Cookies` straight off the disk. So the computer
 * decides this for itself, from what it was started with, as well as the server deciding where to send the person:
 *
 *   - `people`: OpenBot Desktop's host-side computer (`COMPUTER_PEOPLE_ONLY=on`), which runs people's own browsers and
 *     no Bot.
 *   - `one`: a computer started for one id (`COMPUTER_BOT_ID`): an isolated Bot's, or a person's own browser's, as the
 *     supervisor and a Sandbox start them. Started for a person's browser, it runs that browser and nothing else.
 *   - `person`: one person's computer (`COMPUTER_PERSON_ID`), carrying every Bot that person uses. Their Bots share it,
 *     so their own browser does not run there, but Record in one of those Bots' browsers does: the connection it holds
 *     is the person's own, beside only their own Bots' work.
 *   - `shared`: none of these, the one computer every person's Bots reach. No person's browser runs there, and nobody
 *     records in a Bot's browser there.
 */
export type ComputerOwner =
  | { kind: "people" }
  | { kind: "one"; id: string }
  | { kind: "person"; id: string }
  | { kind: "shared" };

export function computerOwner(
  env: Record<string, string | undefined>,
): ComputerOwner {
  if (env[PEOPLE_ONLY_ENV]?.trim().toLowerCase() === "on")
    return { kind: "people" };
  const id = env.COMPUTER_BOT_ID?.trim();
  if (id) return { kind: "one", id };
  const person = env.COMPUTER_PERSON_ID?.trim();
  return person ? { kind: "person", id: person } : { kind: "shared" };
}

/** Why a person's browser is refused on a computer Bots run on. Said to whoever runs OpenBot: the server tells the
 * person their browser cannot open and who can see to it. */
export const NOT_ITS_OWN_COMPUTER =
  "A person's own browser runs only on a computer of its own, and Bots run on this one. Give people's browsers their own computers (COMPUTER_SUPERVISOR_URL or a Sandbox), or OpenBot Desktop's.";

/**
 * Why Record is refused in a Bot's browser on the computer every person shares (`shared`, not a person's own). Record hands the Recorder there a person's own
 * connection, kept in the Bot's profile until Stop, and every other Bot here can run a shell as the same user and read
 * it. Said to whoever runs OpenBot, as `NOT_ITS_OWN_COMPUTER` is; the server tells the person in its own words.
 */
export const NOT_ITS_OWN_COMPUTER_RECORD =
  "Record in a Bot's browser runs only on a computer that Bot does not share, and every Bot runs on this one. Give each Bot its own computer (COMPUTER_SUPERVISOR_URL or a Sandbox).";

/** Why anything but its own browser is refused on a person's computer. */
export const ONLY_THE_PERSONS =
  "This computer runs a person's own browser. Nothing else runs on it.";

/**
 * What this computer refuses an id, before the id reaches anything: a person's browser anywhere but a computer of its
 * own (503, as for any browser this computer cannot run), and anything but the person's on a computer that is theirs
 * (403). Null when the id may go on. A Bot's computer takes Bots as it always has.
 */
export function refusedHere(
  owner: ComputerOwner,
  botId: string,
): { status: 403 | 503; error: string } | null {
  const person = isPersonBrowserId(botId);
  if (owner.kind === "people")
    return person ? null : { status: 403, error: ONLY_THE_PERSONS };
  if (owner.kind === "one" && isPersonBrowserId(owner.id))
    return botId === owner.id ? null : { status: 403, error: ONLY_THE_PERSONS };
  // The shared computer, or a Bot's: a person's browser would sit beside Bots there.
  return person ? { status: 503, error: NOT_ITS_OWN_COMPUTER } : null;
}
