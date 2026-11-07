/**
 * A Bot whose address answers nothing, said in words a person can act on.
 *
 * A run whose Bot cannot be reached ends in a RUN_ERROR carrying the fetch's own message, and both
 * surfaces draw that message as the turn's last line. On Bun that line read "ECONNREFUSED: Unable
 * to connect. Is the computer able to access the url?", which names a socket error and asks the
 * person a question about their computer. A remote Bot's runs now turn a failure to connect into a
 * sentence naming the Bot and the one thing to check, and the error itself goes to the server log,
 * where somebody diagnosing it reads it.
 *
 * On the run rather than on the fetch, so the fetch a Bot is dialled with stays exactly the one it
 * was given (see `remoteTransport`), and an AG-UI Bot and a Mastra one are told the same way.
 */
import type { AbstractAgent, RunAgentInput } from "@ag-ui/client";
import { catchError, throwError } from "rxjs";

/**
 * Failures to connect at all, as Bun and Node's fetch name them.
 *
 * Only these. A refusal the Bot sent back is a response, not an error, and a run the person stopped
 * is an abort, which is theirs and needs no explaining.
 */
const UNREACHABLE = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ETIMEDOUT",
  "ConnectionRefused",
  "ConnectionClosed",
  "FailedToOpenSocket",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

function codeOf(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const own = (error as { code?: unknown }).code;
  if (typeof own === "string") return own;
  // Node's fetch throws "fetch failed" and keeps the socket's code on its cause.
  const cause = (error as { cause?: { code?: unknown } }).cause?.code;
  return typeof cause === "string" ? cause : undefined;
}

/** Whether a fetch failed because nothing answered at the address. */
export function isUnreachable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "AbortError" || error.name === "TimeoutError")
    return false;
  const code = codeOf(error);
  return code !== undefined && UNREACHABLE.has(code);
}

/** The sentence a person reads when their Bot cannot be reached. */
export function unreachableSentence(botName: string): string {
  return `Couldn't reach ${botName}. Check that it's running and that its address on its Setup page is right, then try again.`;
}

export class BotUnreachableError extends Error {
  constructor(botName: string, options: { cause: unknown }) {
    super(unreachableSentence(botName), options);
    this.name = "BotUnreachableError";
  }
}

/** A remote Bot's transport, whose runs say in words when the Bot could not be reached. */
export function sayingWhenUnreachable(
  transport: AbstractAgent,
  bot: { id: string; name: string },
): AbstractAgent {
  const run = transport.run.bind(transport);
  const clone = transport.clone.bind(transport);
  return Object.assign(transport, {
    run: (input: RunAgentInput) =>
      run(input).pipe(
        catchError((error: unknown) => {
          if (!isUnreachable(error)) return throwError(() => error);
          console.error(
            JSON.stringify({
              type: "agent-unreachable",
              bot: bot.id,
              code: codeOf(error),
              error: error instanceof Error ? error.message : String(error),
            }),
          );
          return throwError(
            () => new BotUnreachableError(bot.name, { cause: error }),
          );
        }),
      ),
    clone: () => sayingWhenUnreachable(clone() as AbstractAgent, bot),
  });
}
