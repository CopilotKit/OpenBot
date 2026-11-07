/**
 * Why an action on an element that IS on the page did not finish, from Playwright's own account.
 *
 * Every acting call waits on Playwright's actionability checks (https://playwright.dev/docs/actionability)
 * and then, for a click or a key press, on any navigation it set off. When the time runs out Playwright
 * throws a TimeoutError whose call log says which wait it was stuck in. The server used to read every
 * one of those as an element that had gone, and told the Bot to take a fresh snapshot. A fresh snapshot
 * returns the same ref, so the Bot clicked the same button again, was told the same thing, and looped:
 * nine times on a sign-up form whose page refused to send it, while its Sign up button sat in plain view.
 *
 * The reasons below are the ones Playwright 1.62 logs, captured from a real Chromium. A ref that never
 * resolved, or an element that left the page, is not one of them: that is still a stale ref and still
 * answered as one.
 *
 * Nothing here quotes the page. The call log and the console carry page text (the element Playwright
 * resolved, the one in the way, the address a form posts to), and an error reaches the model outside
 * the envelope that marks page content as untrusted. What is in the way is named by tag, id and class
 * only, cut to a safe alphabet.
 */

export type UnfinishedReason =
  | "refused"
  | "covered"
  | "loading"
  | "hidden"
  | "disabled"
  | "readonly"
  | "moving";

export type UnfinishedAction = { reason: UnfinishedReason; message: string };

/** The markers Playwright writes into a call log, last one wins. */
const MARKERS: [RegExp, UnfinishedReason | "gone"][] = [
  [/intercepts pointer events/, "covered"],
  [/waiting for scheduled navigations to finish/, "loading"],
  // `elementHandle.press` is logged, then focus, the key and the wait for what it started. The first
  // two take milliseconds, so a press that runs out of time is waiting on the page it set loading.
  [/elementHandle\.press\(/, "loading"],
  [/element is not attached to the DOM/i, "gone"],
  [/element is not visible/, "hidden"],
  [/element is not enabled/, "disabled"],
  [/element is not editable/, "readonly"],
  [/element is not stable/, "moving"],
];

/**
 * The browser refusing a form because the page's Content Security Policy forbids sending it
 * (`form-action`). Chromium logs it to the page's console and starts no navigation, so a click or an
 * Enter that submitted the form waits for one until it times out.
 *
 * Both of Chromium's wordings: "Sending form data to '…' violates the following Content Security Policy
 * directive: "form-action 'none'". The request has been blocked." (current), and "Refused to send form
 * data to '…' because it violates …" (before it).
 */
const FORM_REFUSED =
  /form data to .*Content Security Policy directive: "form-action/s;

/**
 * The reason a timed-out action did not finish, or undefined when it is not one of these: a ref that
 * never resolved, an element that left the page, or anything that is not a Playwright timeout.
 *
 * `logged` is what the page wrote to its console while the action ran.
 */
export function unfinishedAction(
  error: unknown,
  logged: readonly string[] = [],
): UnfinishedAction | undefined {
  if (!(error instanceof Error) || error.name !== "TimeoutError")
    return undefined;
  return unfinishedFromLog(error.message, logged);
}

/** {@link unfinishedAction} on the text of the error alone. */
export function unfinishedFromLog(
  log: string,
  logged: readonly string[] = [],
): UnfinishedAction | undefined {
  const timeout = log.match(/Timeout (\d+)ms exceeded/);
  if (!timeout) return undefined;
  // Never found: the ref names nothing on the page, which is a stale ref.
  if (!/locator resolved to/.test(log)) return undefined;
  const lines = log.split("\n");
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index] ?? "";
    const found = MARKERS.find(([marker]) => marker.test(line));
    if (!found) continue;
    let reason = found[1];
    if (reason === "gone") return undefined;
    // The action landed and the page is not loading anything: it refused to send the form.
    if (reason === "loading" && logged.some((text) => FORM_REFUSED.test(text)))
      reason = "refused";
    const seconds = Math.max(1, Math.round(Number(timeout[1]) / 1000));
    return { reason, message: messageFor(reason, seconds, line) };
  }
  return undefined;
}

function messageFor(
  reason: UnfinishedReason,
  seconds: number,
  line: string,
): string {
  switch (reason) {
    case "refused":
      return "The page refused to send the form, so nothing was sent. Its security policy doesn't allow this form to be submitted, and trying again won't change that. Tell the person what happened.";
    case "covered": {
      const by = coveringElement(line);
      return `Something on the page is covering that element${by ? ` (${by})` : ""}, so the click can't reach it. Close or move whatever is in the way, take a new snapshot, and try again.`;
    }
    case "loading":
      return `That went through and the page started loading, for example to send a form, but it hadn't finished after ${seconds} seconds. Don't do it again, or the form could be sent twice. Wait a moment, then look at the page again.`;
    case "hidden":
      return "That element is on the page but hidden, so it can't be used. Open or scroll to whatever shows it, take a new snapshot, and try again.";
    case "disabled":
      return "That element is turned off on the page, so it can't be used yet. The page may need something else done first. Take a new snapshot to check.";
    case "readonly":
      return "That field can't be typed into. It's read-only on the page.";
    case "moving":
      return "That element kept moving, so it couldn't be used. Wait a moment, take a new snapshot, and try again.";
  }
}

/**
 * What a call log says is in the way, as `tag#id.class`, or undefined when it says nothing usable.
 *
 * Playwright logs either `<x …>…</x> intercepts pointer events` or, when the element in the way is
 * inside a bigger one, `<x …>…</x> from <y …>…</y> subtree intercepts pointer events`. The bigger one
 * is the thing to close (the dialog, the banner), so it is the one named.
 */
export function coveringElement(line: string): string | undefined {
  const tags = [...line.matchAll(/<([a-zA-Z][\w-]*)((?:\s[^>]*)?)>/g)];
  const subtree = /\bfrom <[^>]*>.*\bsubtree intercepts pointer events/.test(
    line,
  );
  // The opening tag after "from", or the first one when there is no subtree.
  const chosen = subtree
    ? tags.find((tag) => line.lastIndexOf(" from ", tag.index) !== -1)
    : tags[0];
  if (!chosen) return undefined;
  const tag = safe(chosen[1] ?? "").toLowerCase();
  if (!tag) return undefined;
  const attributes = chosen[2] ?? "";
  const id = safe(attributes.match(/\sid="([^"]*)"/)?.[1] ?? "");
  const classes = (attributes.match(/\sclass="([^"]*)"/)?.[1] ?? "")
    .split(/\s+/)
    .map(safe)
    .filter(Boolean)
    .slice(0, 2);
  return `${tag}${id ? `#${id}` : ""}${classes.map((name) => `.${name}`).join("")}`;
}

/** Letters, digits, `-` and `_`, at most 40 of them: enough to name a thing, too little to say anything. */
function safe(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
}
