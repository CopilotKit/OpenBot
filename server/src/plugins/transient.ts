/**
 * An app's read that failed for a reason that passes, tried again before the Bot hears of it.
 *
 * A timeout, a rate limit (429) or the app's own server failing (5xx) says nothing about the request:
 * the same read a second later usually answers. Handed to the model as it was, the Bot either gave
 * up on the lookup or spent a step of its run asking again, and a Bot sending 20 lookups at once
 * meets exactly these: an app answering a burst with 429s for its tail.
 *
 * ONLY A READ IS TRIED AGAIN, AND THE CALLER DECIDES WHICH IT IS. A write that timed out may have
 * landed, and sending it again could send the email twice; whether it did is for the Bot to find out,
 * not for this deployment to guess. `withReadRetries` is only ever handed a call `classifyTool`
 * called a read.
 */

/** How long to wait before each further try: twice, half a second and then a second and a half. */
export const READ_RETRY_DELAYS_MS = [500, 1500] as const;

/** The HTTP statuses that say "not now" rather than "not this": request timeout, too early, 429, 5xx. */
function passingStatus(status: unknown): boolean {
  return (
    typeof status === "number" &&
    (status === 408 ||
      status === 425 ||
      status === 429 ||
      (status >= 500 && status <= 599))
  );
}

/** MCP's own "the server did not answer in time" (`ErrorCode.RequestTimeout`). */
const MCP_REQUEST_TIMEOUT = -32001;

/** A connection that dropped or never opened, by the code Node, Bun and undici give it. */
const NETWORK_CODES = new Set([
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "EAI_AGAIN",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "ConnectionRefused",
  "ConnectionClosed",
]);

/**
 * How an app says "not now" in words: a rate limit, an overload, a timeout. Read only on an app's
 * own error ANSWER, never on a thrown error, whose message can be anything (this deployment's own
 * database saying "statement timeout" among them).
 */
const PASSING_WORDS =
  /\b(timed? ?out|timeout|Too Many Requests|rate[- ]limit(?:ed)?|Service Unavailable|Bad Gateway|Gateway Time-?out|temporarily unavailable)\b/i;

type ErrorLike = {
  name?: unknown;
  transient?: unknown;
  status?: unknown;
  statusCode?: unknown;
  code?: unknown;
  response?: { status?: unknown };
  message?: unknown;
  cause?: unknown;
};

/**
 * THIS DEPLOYMENT'S OWN DATABASE IS NEVER A VENDOR THAT MIGHT ANSWER NEXT TIME. A query it refused
 * is a fault of ours, said elsewhere without its statement (`withoutStatement`), and trying it again
 * here would only hide that behind three tries.
 */
function ourDatabase(value: ErrorLike): boolean {
  return (
    value.name === "DrizzleQueryError" ||
    value.name === "PostgresError" ||
    (typeof value.message === "string" &&
      value.message.startsWith("Failed query:"))
  );
}

/**
 * Whether a thrown failure is one that passes. Looks at the error and what it was caused by, since a
 * transport's error is often wrapped (Composio's SDK wraps a 500 in a "could not fetch" error).
 */
export function transientFailure(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth++) {
    if (typeof current !== "object") return false;
    const value = current as ErrorLike;
    if (ourDatabase(value)) return false;
    if (value.transient === true) return true;
    if (
      passingStatus(value.status) ||
      passingStatus(value.statusCode) ||
      passingStatus(value.code) ||
      passingStatus(value.response?.status)
    )
      return true;
    if (value.code === MCP_REQUEST_TIMEOUT) return true;
    if (typeof value.code === "string" && NETWORK_CODES.has(value.code))
      return true;
    // `fetch` itself, when the app could not be reached at all.
    if (
      value.name === "TypeError" &&
      typeof value.message === "string" &&
      /fetch failed|Unable to connect/i.test(value.message)
    )
      return true;
    current = value.cause;
  }
  return false;
}

/**
 * Whether an app's own error answer says "not now": an MCP server that answers a rate limit or an
 * upstream outage as an `isError` result rather than as an HTTP status. Read only on an error answer,
 * so a document that happens to mention a 503 is never taken for one.
 */
export function transientAnswer(answer: {
  text: string;
  isError: boolean;
}): boolean {
  return (
    answer.isError &&
    (PASSING_WORDS.test(answer.text) ||
      /\b(?:HTTP|status|error)[ :]*(?:408|425|429|5\d\d)\b/i.test(answer.text))
  );
}

/**
 * The failure given back after every try, saying it was tried, so the Bot does not spend a step
 * trying it again at once. The error itself is kept, class and cause and all, because what reads it
 * next (the trail, the refusal and fault checks) decides by what it is.
 */
function saysItWasTried(error: unknown, tries: number): unknown {
  if (error instanceof Error) {
    try {
      error.message = `${error.message.trim().replace(/\.?$/, ".")} OpenBot tried it ${tries} times over a few seconds and it failed each time.`;
    } catch {
      // A message that cannot be written is given back as it was.
    }
  }
  return error;
}

/**
 * One read, tried again on a failure that passes: {@link READ_RETRY_DELAYS_MS} apart, then given back.
 *
 * A failure that does not pass (a refusal, a 404, a bad argument, a fault of ours) is given back at
 * once, as it was. An error ANSWER that passes is tried again too, and the last one given back as it
 * is, since the app's own words are the best account of it.
 */
export async function withReadRetries<
  T extends { text: string; isError: boolean },
>(
  read: () => Promise<T>,
  sleep: (milliseconds: number) => Promise<unknown> = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
): Promise<T> {
  const tries = READ_RETRY_DELAYS_MS.length + 1;
  for (let attempt = 1; ; attempt++) {
    let answer: T;
    try {
      answer = await read();
    } catch (error) {
      if (!transientFailure(error)) throw error;
      if (attempt >= tries) throw saysItWasTried(error, tries);
      await sleep(READ_RETRY_DELAYS_MS[attempt - 1] ?? 0);
      continue;
    }
    if (!transientAnswer(answer) || attempt >= tries) return answer;
    await sleep(READ_RETRY_DELAYS_MS[attempt - 1] ?? 0);
  }
}
