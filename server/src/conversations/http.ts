/**
 * How OpenBot calls one of Intelligence's typed capabilities under this deployment's project key.
 *
 * The same rules as the agent registry client (agents/bot-registry/client.ts): every write carries
 * an `Idempotency-Key`, a write that fails on the way (the connection drops, Intelligence answers
 * 5xx) is sent again under the same key, and nothing here holds a database connection, so a caller
 * must never call this with an OpenBot transaction open.
 */

export type IntelligenceApiSettings = {
  apiUrl: string;
  apiKey: string;
  /** For tests that need to observe or stub the transport. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
};

/** Intelligence refused or could not answer. `code` is the error code when it sent one. */
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

export type RequestOptions = {
  body?: unknown;
  idempotencyKey?: string;
  ifMatch?: number;
};

export type IntelligenceHttp = (
  method: string,
  path: string,
  options?: RequestOptions,
) => Promise<Response>;

const ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 15_000;

/** A fresh key for one logical write. Retries of that write reuse it. */
export function writeKey(operation: string): string {
  return `openbot:${operation}:${crypto.randomUUID()}`;
}

export function createIntelligenceHttp(
  settings: IntelligenceApiSettings,
): IntelligenceHttp {
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

/** Throw the refusal as an error that names it. */
export async function refused(
  response: Response,
  what: string,
): Promise<never> {
  const code = await errorCode(response);
  throw new IntelligenceApiError(
    `Intelligence refused to ${what}: ${response.status}${code ? ` ${code}` : ""}.`,
    response.status,
    code,
  );
}

function pause(attempt: number) {
  return new Promise((resolve) => setTimeout(resolve, 150 * attempt * attempt));
}

export const encode = encodeURIComponent;

export const date = (value: string | null | undefined): Date | null =>
  value ? new Date(value) : null;
