import {
  type CopilotKitIntelligence,
  PlatformRequestError,
} from "@copilotkit/runtime/v2";

/**
 * Asking Intelligence a question whose "no" is an ordinary answer, without the runtime client printing the "no".
 *
 * The runtime client prints every answer outside 2xx as a multi-line `Intelligence platform request failed` object
 * (its logger is `console`), unless the method it came through passed that status as expected, and only its private
 * get-or-create does. So a conversation nobody has run yet printed two failures as it opened: the browser reading its
 * history and Learning asking whether it is new both got the 404 a new thread is. And an answer from one Bot to another
 * that arrived while the asking Bot was still finishing its sentence printed the 409 of a busy conversation, though
 * the hop waits that out by design.
 *
 * Each question here is the client's own request (the same address, headers and body, see `IntelligenceKnowingANewThread`
 * and the test that pins them together), sent with `fetch` directly so the answer is looked at before anything is
 * printed. The one expected status becomes the client's own `PlatformRequestError`, unprinted. Every other answer, and
 * no answer at all, is handed back to the client's own method, which asks again and reports it exactly as it always
 * has: a real failure still prints, once, in the client's words.
 */
export type PlatformAddress = Pick<
  CopilotKitIntelligence,
  "ɵgetApiUrl" | "ɵgetApiKey"
>;

export type PlatformAnswer = {
  status: number;
  statusText: string;
  text: string;
};

/** The client's request, unprinted. Undefined when nothing answered, which is the client's to report. */
export async function askPlatform(
  platform: PlatformAddress,
  request: {
    method: "GET" | "POST";
    path: string;
    body?: unknown;
    headers?: Record<string, string>;
  },
): Promise<PlatformAnswer | undefined> {
  try {
    const response = await fetch(`${platform.ɵgetApiUrl()}${request.path}`, {
      method: request.method,
      headers: {
        Authorization: `Bearer ${platform.ɵgetApiKey()}`,
        "Content-Type": "application/json",
        ...request.headers,
      },
      body: request.body ? JSON.stringify(request.body) : undefined,
    });
    return {
      status: response.status,
      statusText: response.statusText,
      text: await response.text(),
    };
  } catch {
    // Nothing answered, or the answer broke off: either way the client's own request says so.
    return undefined;
  }
}

export function answered(
  answer: PlatformAnswer | undefined,
): answer is PlatformAnswer {
  return answer !== undefined && answer.status >= 200 && answer.status < 300;
}

/** A 2xx body, read as the client reads it. */
export function bodyOf<T>(answer: PlatformAnswer): T {
  return (answer.text ? JSON.parse(answer.text) : undefined) as T;
}

/** The error the client throws for this answer, built as its own request builds it, and not printed. */
export function expectedRefusal(answer: PlatformAnswer): PlatformRequestError {
  return new PlatformRequestError(
    `Intelligence platform error ${answer.status}: ${answer.text || answer.statusText}`,
    answer.status,
    retryableHint(answer.text),
  );
}

/** The platform's `error.retryable`, where its envelope says. */
function retryableHint(text: string): boolean | undefined {
  try {
    const retryable = (
      JSON.parse(text) as { error?: { retryable?: unknown } } | null
    )?.error?.retryable;
    return typeof retryable === "boolean" ? retryable : undefined;
  } catch {
    return undefined;
  }
}
