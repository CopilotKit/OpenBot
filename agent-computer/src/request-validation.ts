/**
 * The shape of a call, checked before it reaches the browser or the shell.
 *
 * This process holds no policy engine: the server gateway decides whether an action may run. What
 * is checked here is whether the request is well-formed at all, so a typo'd caller gets a 400
 * naming the field rather than a 502 that reads as a broken computer.
 */

/** Long enough for an install, short enough that a hung command is not a hung Bot. */
export const EXEC_DEFAULT_TIMEOUT_MS = 120_000;
/** A command has to be given long enough to start. Below this, a caller is asking for nothing. */
export const EXEC_MIN_TIMEOUT_MS = 1_000;
export const EXEC_MAX_TIMEOUT_MS = 600_000;

export type NavigateParseResult =
  | { ok: true; url: string }
  | { ok: false; error: string };

/**
 * A navigation target, checked before Playwright is asked.
 *
 * An empty string used to travel into `page.goto` and come back as a 502 "Navigation failed",
 * which reads as a broken computer rather than a caller error. A `javascript:`, `file://`, or
 * `data:` URL is never a page a Bot should be sent to from this endpoint.
 */
export function parseNavigateUrl(input: unknown): NavigateParseResult {
  if (typeof input !== "string" || !input.trim()) {
    return { ok: false, error: "A url is required." };
  }
  const trimmed = input.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: "That is not a valid http(s) URL." };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "Only http(s) URLs can be opened." };
  }
  return { ok: true, url: trimmed };
}

export type ExecTimeoutParseResult =
  | { ok: true; timeoutMs: number | undefined }
  | { ok: false; error: string };

const EXEC_TIMEOUT_ERROR =
  "timeoutMs must be a whole number of milliseconds between 1000 and 600000.";

/**
 * A shell timeout, checked before the command is spawned.
 *
 * A `NaN` or `Infinity` used to travel into `Math.min(Math.max(...))` as `NaN`, so `setTimeout`
 * fired immediately: the command was killed before it did anything and the answer said it had
 * timed out, which is true and useless. Anything outside the shell's own bounds answers 400 here,
 * matching the server gateway's validation of the same field.
 */
export function parseExecTimeout(input: unknown): ExecTimeoutParseResult {
  if (input === undefined) return { ok: true, timeoutMs: undefined };
  if (
    typeof input !== "number" ||
    !Number.isInteger(input) ||
    input < EXEC_MIN_TIMEOUT_MS ||
    input > EXEC_MAX_TIMEOUT_MS
  ) {
    return { ok: false, error: EXEC_TIMEOUT_ERROR };
  }
  return { ok: true, timeoutMs: input };
}
