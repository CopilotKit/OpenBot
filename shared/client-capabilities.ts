/**
 * What an app says it understands, so the server answers it in shapes it can read.
 *
 * A newer server can answer in a shape an older app doesn't know. Gated on the app's version, that
 * depends on releases going out in order, and on a constant nobody forgets to move. So an app says,
 * on every request, which answers it understands: `OpenBot-Capabilities: <token> <token>`, lowercase
 * tokens separated by spaces. A server sends a newer shape only to a request naming its token, and
 * the shape before it to everything else. A token a server doesn't know means nothing to it.
 *
 * A browser can't set a header on a WebSocket, so the conversation events socket takes the same list
 * in its `capabilities` query parameter.
 *
 * The web app and the server read this file. Documented in api/openapi/common.yaml.
 */

/** The request header an app lists what it understands in. */
export const CAPABILITIES_HEADER = "OpenBot-Capabilities";

/** The conversation events socket's query parameter for the same list. */
export const CAPABILITIES_QUERY = "capabilities";

/**
 * A computer step the server has already run, or is running, is answered as such: `taken` from
 * runComputerStep, and COMPUTER_STEP_RUNNING or COMPUTER_STEP_OUTCOME_UNKNOWN from a direct computer
 * call that names its step. Without it, a request is answered as it was before these existed.
 */
export const COMPUTER_STEP_TAKEN = "computer-step-taken";

/**
 * A conversation's work can name the person's own turn, which the server is carrying on with no
 * page open (`turn`). Without it, a request or socket is sent work without it.
 */
export const CONVERSATION_WORK_TURN = "conversation-work-turn";

/** Every token this release knows, for a server reading a request. */
export const KNOWN_CAPABILITIES: readonly string[] = [
  COMPUTER_STEP_TAKEN,
  CONVERSATION_WORK_TURN,
];

/** The most tokens read from one value: a list longer than this is cut, never refused. */
const MOST = 32;

/** The tokens a header or query value names, lowercased, each once, in the order written. */
export function parseCapabilities(
  value: string | null | undefined,
): ReadonlySet<string> {
  const tokens = new Set<string>();
  if (!value?.trim()) return tokens;
  for (const token of value.trim().split(/\s+/).slice(0, MOST)) {
    const lower = token.toLowerCase();
    if (/^[a-z0-9][a-z0-9-]{0,63}$/.test(lower)) tokens.add(lower);
  }
  return tokens;
}

/** Whether a header or query value names `token`. */
export function hasCapability(
  value: string | null | undefined,
  token: string,
): boolean {
  return parseCapabilities(value).has(token.toLowerCase());
}

/** A list of tokens as a header or query value. */
export function capabilitiesValue(tokens: readonly string[]): string {
  return tokens.join(" ");
}
