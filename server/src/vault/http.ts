/**
 * How OpenBot calls Intelligence's vault and connections APIs: under this deployment's project key,
 * with every write carrying an `Idempotency-Key`, and a write that fails on the way (the connection
 * drops, Intelligence answers 5xx) retried with the same key, so a retry after a lost response is the
 * same write rather than a second one. A read is safe to repeat. Nothing here holds a database
 * connection: a caller must never call this with an OpenBot transaction open.
 */

export type IntelligenceApiSettings = {
  apiUrl: string;
  apiKey: string;
  /** For tests that need to observe or stub the transport. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
};

/** Intelligence refused or could not answer. `code` is the API's error code when it sent one. */
export class IntelligenceApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly code: string | null,
  ) {
    super(message);
    this.name = "IntelligenceApiError";
  }
}

const ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 15_000;

/** A fresh key for one logical write. Retries of that write reuse it. */
export function idempotencyKey(operation: string): string {
  return `openbot:${operation}:${crypto.randomUUID()}`;
}

export type IntelligenceRequest = (
  method: string,
  path: string,
  options?: { body?: unknown; idempotencyKey?: string; ifMatch?: number },
) => Promise<Response>;

export function createIntelligenceRequest(
  settings: IntelligenceApiSettings,
): IntelligenceRequest {
  const base = settings.apiUrl.replace(/\/+$/, "");
  const send = settings.fetch ?? fetch;
  return async (method, path, options = {}) => {
    const headers: Record<string, string> = {
      authorization: `Bearer ${settings.apiKey}`,
      accept: "application/json",
    };
    if (options.body !== undefined)
      headers["content-type"] = "application/json";
    if (options.idempotencyKey)
      headers["idempotency-key"] = options.idempotencyKey;
    if (options.ifMatch !== undefined)
      headers["if-match"] = `"${options.ifMatch}"`;
    let lastError: unknown;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      try {
        const response = await send(`${base}${path}`, {
          method,
          headers,
          ...(options.body === undefined
            ? {}
            : { body: JSON.stringify(options.body) }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        // A 5xx is Intelligence failing, not refusing: the same write under the same key is safe to
        // send again, and a read is safe to repeat.
        if (response.status >= 500 && attempt < ATTEMPTS) {
          lastError = new IntelligenceApiError(
            `Intelligence answered ${response.status} to ${method} ${path}.`,
            response.status,
            await errorCode(response),
          );
          await pause(attempt);
          continue;
        }
        return response;
      } catch (error) {
        lastError = error;
        if (attempt < ATTEMPTS) await pause(attempt);
      }
    }
    if (lastError instanceof IntelligenceApiError) throw lastError;
    throw new IntelligenceApiError(
      `Could not reach Intelligence for ${method} ${path}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      null,
      null,
    );
  };
}

/** The error code an Intelligence refusal carries, or null. */
export async function errorCode(response: Response): Promise<string | null> {
  try {
    const body = (await response.clone().json()) as {
      error?: { code?: unknown };
    };
    return typeof body.error?.code === "string" ? body.error.code : null;
  } catch {
    return null;
  }
}

function pause(attempt: number) {
  return new Promise((resolve) => setTimeout(resolve, 150 * attempt * attempt));
}

/** Every page of a cursor listing. There is no cap: the cursor decides the end. */
export async function walkPages<T>(
  page: (
    cursor: string | null,
  ) => Promise<{
    items: T[];
    nextCursor: string | null;
    joinCode: string | null;
  }>,
): Promise<{ items: T[]; joinCode: string | null }> {
  const items: T[] = [];
  let cursor: string | null = null;
  let joinCode: string | null = null;
  do {
    const next: Awaited<ReturnType<typeof page>> = await page(cursor);
    items.push(...next.items);
    joinCode = next.joinCode ?? joinCode;
    cursor = next.nextCursor;
  } while (cursor);
  return { items, joinCode };
}
