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

/** A network failure or a timeout, as Node, Bun, undici and the MCP SDK word them. */
const PASSING_WORDS =
  /\b(timed? ?out|timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|EPIPE|socket hang up|fetch failed|network error|Too Many Requests|rate[- ]limit(?:ed)?|Service Unavailable|Bad Gateway|Gateway Time-?out|temporarily unavailable)\b/i;

/**
 * Whether a thrown failure is one that passes. Looks at the error and what it was caused by, since a
 * transport's error is often wrapped (Composio's SDK wraps a 500 in a "could not fetch" error).
 */
export function transientFailure(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth++) {
    if (typeof current !== "object") return false;
    const value = current as {
      transient?: unknown;
      status?: unknown;
      statusCode?: unknown;
      code?: unknown;
      response?: { status?: unknown };
      message?: unknown;
      cause?: unknown;
    };
    if (value.transient === true) return true;
    if (
      passingStatus(value.status) ||
      passingStatus(value.statusCode) ||
      passingStatus(value.code) ||
      passingStatus(value.response?.status)
    )
      return true;
    if (value.code === MCP_REQUEST_TIMEOUT) return true;
    if (typeof value.code === "string" && PASSING_WORDS.test(value.code))
      return true;
    if (typeof value.message === "string" && PASSING_WORDS.test(value.message))
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
export function transientAnswer(answer: { text: string; isError: boolean }) {
  return (
    answer.isError &&
    (PASSING_WORDS.test(answer.text) ||
      /\b(?:HTTP|status|error)[ :]*(?:408|425|429|5\d\d)\b/i.test(answer.text))
  );
}

/** A read that kept failing for a reason that passes, after every try. Says so, for the Bot. */
export class ReadRetriedError extends Error {
  constructor(
    readonly tries: number,
    readonly last: unknown,
  ) {
    const said = last instanceof Error ? last.message : String(last);
    super(
      `${said.trim().replace(/\.?$/, ".")} OpenBot tried it ${tries} times over a few seconds and it failed each time.`,
      { cause: last },
    );
    this.name = "ReadRetriedError";
  }
}

/**
 * One read, tried again on a failure that passes: {@link READ_RETRY_DELAYS_MS} apart, then given back.
 *
 * A failure that does not pass (a refusal, a 404, a bad argument) is given back at once, as it was.
 * An error ANSWER that passes is tried again too, and the last one given back as it is, since the
 * app's own words are the best account of it.
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
      if (attempt >= tries) throw new ReadRetriedError(tries, error);
      await sleep(READ_RETRY_DELAYS_MS[attempt - 1] ?? 0);
      continue;
    }
    if (!transientAnswer(answer) || attempt >= tries) return answer;
    await sleep(READ_RETRY_DELAYS_MS[attempt - 1] ?? 0);
  }
}
