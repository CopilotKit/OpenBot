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
import { browserComputerPaths } from "../../shared/openbot-browser";

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
