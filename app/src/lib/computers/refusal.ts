import { ClientError } from "@/lib/client";

/** The organization already has as many computers as OpenBot allows it. An admin makes room on Computers. */
export const COMPUTER_LIMIT_REACHED = "COMPUTER_LIMIT_REACHED";

/**
 * A refusal that asking again can't change: the server said so (`retryable: false` on its problem).
 * Opening a computer it refused this way is shown as blocked, in the server's sentence, with no Tentar novamente.
 * Anything else that failed (a network error, a refusal that may pass) is not one, and keeps its Tentar novamente.
 */
export function settledRefusal(error: unknown): ClientError | null {
  return error instanceof ClientError && error.body?.retryable === false
    ? error
    : null;
}

/**
 * The computer limit's refusal, and only that: Para a request that opens a Computador among other things (Record, which
 * opens the Navegador and then starts the Recorder), where Qualquer other settled refusal É the other thing's.
 */
export function atComputerLimit(error: unknown): ClientError | null {
  const refused = settledRefusal(error);
  return refused?.code === COMPUTER_LIMIT_REACHED ? refused : null;
}
