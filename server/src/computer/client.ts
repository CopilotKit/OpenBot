import type { HandoffRequest } from "@openbot/shared/computer-control";
import type { NavigateResult } from "./schema";
import { checkNavigationTarget } from "./target";

/** The computer did not accept or answer a request. */
export class ComputerUnavailableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "ComputerUnavailableError";
  }
}

/**
 * A person pressed Stop and the action was aborted mid-flight.
 *
 * A subclass of `ComputerUnavailableError` on purpose: everything downstream that catches an
 * unavailable computer to tell the model still catches this unchanged. What it adds is a type the
 * gateway can see, so the audit row it writes is `computer.action_stopped` rather than
 * `computer.action_failed` -- a stop is not an outage, and a count of failures that includes every
 * Stop reports one where there was none.
 */
export class ComputerStoppedError extends ComputerUnavailableError {
  constructor(reason: string) {
    super(reason);
    this.name = "ComputerStoppedError";
  }
}

/**
 * What every caller is told when a computer did not finish starting in time.
 *
 * Written for the model and for a person at once, because both read it: the headless tools hand it
 * to the model as the result, and the routes send it to the browser, which shows it on the line.
 */
export const STILL_STARTING_MESSAGE =
  "The computer is still starting. This call was not performed. Try it again in a moment.";

/**
 * The wait for a cold computer ran out before it could take the call.
 *
 * A NORMAL WAIT THAT RAN LONG, NOT AN OUTAGE. A computer that was asleep costs a pod schedule and a
 * browser launch to wake, and the first start pulls an image as well, so a minute is ordinary and
 * two is not unheard of. Reporting that as a failure put red text and "did not become ready" in
 * front of somebody whose computer was, at that moment, finishing its start.
 *
 * A subclass of `ComputerUnavailableError`, so everything that already catches an unavailable
 * computer still does. What the type adds is that every surface can say the gentle thing instead:
 * the route marks the body `starting`, the headless tools answer with a result rather than a throw,
 * and the browser renders it as a wait rather than a failure. The message says the call was NOT
 * performed, which is true by construction: this is only thrown before anything reached the
 * computer, so a retry cannot do the thing twice.
 */
export class ComputerStillStartingError extends ComputerUnavailableError {
  constructor(reason: string = STILL_STARTING_MESSAGE) {
    super(reason);
    this.name = "ComputerStillStartingError";
  }
}

/** The requested element is not on the current page. */
export class ElementNotFoundError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "ElementNotFoundError";
  }
}

/** The navigation target is not permitted. */
export class NavigationRefusedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "NavigationRefusedError";
  }
}

/** The computer refused access to a path outside its workspace. */
export class WorkspaceRefusedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "WorkspaceRefusedError";
  }
}

/** The workspace request names a path or value that cannot be used. */
export class WorkspaceRequestError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "WorkspaceRequestError";
  }
}

/** The workspace has no file at the requested path. */
export class WorkspaceNotFoundError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "WorkspaceNotFoundError";
  }
}

/** The requested workspace file is larger than the download limit. */
export class WorkspaceTooLargeError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "WorkspaceTooLargeError";
  }
}

/** Raw bytes and their size, kept as a stream until the caller sends them onward. */
export type ComputerDownload = {
  body: ReadableStream<Uint8Array>;
  bytes: number;
};

/** The page changed after the caller received its element references. */
export class StaleSnapshotError extends Error {
  constructor(
    reason: string,
    readonly snapshotRequired = false,
  ) {
    super(reason);
    this.name = "StaleSnapshotError";
  }
}

/**
 * A person has the wheel, so the Bot's action was not carried out.
 *
 * Its own condition rather than a stale snapshot, though both arrive as 409, because what the caller
 * should do next is the opposite in each case. Stale refs mean take a fresh snapshot and go again;
 * this means stop and leave the browser to the person holding it. Told apart by the flag the computer
 * puts on the body, which is the only thing in the response that distinguishes them.
 */
export class HumanHasControlError extends Error {
  constructor(
    reason: string,
    readonly requestId?: string,
    readonly handoff?: HandoffRequest,
  ) {
    super(reason);
    this.name = "HumanHasControlError";
  }
}

/** Invalid, unknown, or superseded handoff identity is distinct from page freshness. */
export class HandoffRequestError extends Error {
  constructor(
    reason: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(reason);
    this.name = "HandoffRequestError";
  }
}

/**
 * Transport options used inside the computer gateway.
 *
 * This is an internal seam. Application code uses ComputerGateway and does not
 * use this interface directly.
 */
export type ComputerTransportOptions = {
  token?: string;
  allowPrivateHosts?: boolean;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

/**
 * Which seat on the computer a request is for.
 *
 * The Bot alone on a computer of one person's own (or an isolated Bot's), where each Bot is a seat;
 * the Bot and the person on the computer many people share, where the seat is the pair. A string is
 * the Bot alone.
 */
export type SeatAddress = string | { botId: string; personId?: string };

/** Internal HTTP interface used only by ComputerGateway. */
export interface ComputerTransport {
  call<T>(
    baseUrl: string,
    botId: SeatAddress,
    path: string,
    init?: RequestInit,
    caller?: AbortSignal,
    /** Overrides the transport's own deadline for this one call. */
    timeoutMs?: number,
  ): Promise<T>;
  post<T>(
    baseUrl: string,
    botId: SeatAddress,
    path: string,
    payload: unknown,
    caller?: AbortSignal,
    /** Overrides the transport's own deadline for this one call. */
    timeoutMs?: number,
  ): Promise<T>;
  navigate(
    baseUrl: string,
    botId: SeatAddress,
    url: string,
    toolCallId?: string,
  ): Promise<NavigateResult>;
  download(
    baseUrl: string,
    botId: SeatAddress,
    path: string,
    caller?: AbortSignal,
    timeoutMs?: number,
  ): Promise<ComputerDownload>;
}

/** The headers that name a seat to the computer. See {@link SeatAddress}. */
export function seatHeaders(seat: SeatAddress): Record<string, string> {
  const { botId, personId } =
    typeof seat === "string" ? { botId: seat, personId: undefined } : seat;
  return {
    "x-openbot-bot-id": botId,
    ...(personId ? { "x-openbot-person-id": personId } : {}),
  };
}

/**
 * Send authenticated HTTP requests to one located agent-computer process.
 *
 * Lifecycle and location are deliberately absent. ComputerGateway owns those
 * operations through ComputerProvider.
 */
export function createComputerTransport(
  options: ComputerTransportOptions,
): ComputerTransport {
  const doFetch = options.fetchImpl ?? fetch;
  const defaultTimeoutMs = options.timeoutMs ?? 45_000;

  async function request(
    baseUrl: string,
    botId: SeatAddress,
    path: string,
    init?: RequestInit,
    caller?: AbortSignal,
    timeoutMsOverride?: number,
  ): Promise<Response> {
    if (caller?.aborted) {
      throw new ComputerStoppedError("The action was stopped.");
    }

    /*
     * A browser action either happens in seconds or has gone wrong, so 45s is the right deadline for
     * it. A command is not that: the shell's own budget is 120s by default and up to 600s, and the
     * tool description tells the model to install packages. Giving up here first reported failure to
     * the person while the command carried on running to completion inside the container, and made
     * the shell's own limit unreachable. A caller with a longer limit of its own passes it in, and
     * this becomes the backstop rather than the limit.
     */
    const timeoutMs = timeoutMsOverride ?? defaultTimeoutMs;
    const target = baseUrl.replace(/\/$/, "");
    let response: Response;
    try {
      response = await doFetch(`${target}${path}`, {
        ...init,
        headers: {
          ...(init?.headers as Record<string, string> | undefined),
          ...seatHeaders(botId),
          ...(options.token
            ? { "x-openbot-computer-token": options.token }
            : {}),
        },
        signal: caller
          ? AbortSignal.any([caller, AbortSignal.timeout(timeoutMs)])
          : AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      /*
       * The caller's own abort is answered first, and says what the check above the fetch says.
       *
       * The signal is handed to fetch precisely so a Stop can land mid-flight, and a fetch aborted
       * that way rejects with an AbortError, which is neither a TimeoutError nor a computer that is
       * not running. Both of the other answers are statements about the infrastructure, and this
       * message is not only read by the model: the gateway writes it into the action's audit row,
       * and the type below is what keeps that row a stop rather than an outage.
       */
      if (caller?.aborted) {
        throw new ComputerStoppedError("The action was stopped.");
      }
      throw new ComputerUnavailableError(
        error instanceof Error && error.name === "TimeoutError"
          ? "The Bot's computer didn't respond in time."
          : "The Bot's computer isn't running.",
      );
    }
    return response;
  }

  async function call<T>(
    baseUrl: string,
    botId: SeatAddress,
    path: string,
    init?: RequestInit,
    caller?: AbortSignal,
    timeoutMsOverride?: number,
  ): Promise<T> {
    const response = await request(
      baseUrl,
      botId,
      path,
      init,
      caller,
      timeoutMsOverride,
    );
    const body = (await response.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!response.ok) {
      throwMappedError(response.status, body);
    }
    return body as T;
  }

  async function download(
    baseUrl: string,
    botId: SeatAddress,
    path: string,
    caller?: AbortSignal,
    timeoutMs?: number,
  ): Promise<ComputerDownload> {
    const response = await request(
      baseUrl,
      botId,
      path,
      { method: "GET" },
      caller,
      timeoutMs,
    );
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as Record<
        string,
        unknown
      > | null;
      throwMappedError(response.status, body);
    }

    const length = response.headers.get("content-length");
    const bytes =
      length !== null && /^\d+$/.test(length) ? Number(length) : Number.NaN;
    if (!response.body || !Number.isSafeInteger(bytes) || bytes < 0) {
      // Nothing else will ever read this body, so release it here rather than
      // leaving the whole download budget checked out of the pool. A cancel that
      // fails must not replace the refusal the caller is told about.
      await response.body?.cancel().catch(() => undefined);
      throw new ComputerUnavailableError(
        "The Bot's computer sent back a file that couldn't be read.",
      );
    }
    return { body: response.body, bytes };
  }

  function post<T>(
    baseUrl: string,
    botId: SeatAddress,
    path: string,
    payload: unknown,
    caller?: AbortSignal,
    timeoutMs?: number,
  ): Promise<T> {
    return call<T>(
      baseUrl,
      botId,
      path,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      },
      caller,
      timeoutMs,
    );
  }

  async function navigate(
    baseUrl: string,
    botId: SeatAddress,
    url: string,
    toolCallId?: string,
  ): Promise<NavigateResult> {
    const verdict = checkNavigationTarget(url, {
      allowPrivateHosts: options.allowPrivateHosts,
    });
    if (!verdict.allowed) {
      throw new NavigationRefusedError(verdict.reason);
    }
    return post<NavigateResult>(baseUrl, botId, "/navigate", {
      url: verdict.url,
      ...(toolCallId ? { toolCallId } : {}),
    });
  }

  return { call, post, navigate, download };
}

/** Map agent-computer responses to errors that a caller can act on. */
function throwMappedError(
  status: number,
  body: Record<string, unknown> | null,
): never {
  const detail =
    typeof body?.error === "string" ? body.error : `HTTP ${status}`;
  if (
    body?.controlRequestError === true &&
    (status === 400 || status === 404 || status === 409)
  )
    throw new HandoffRequestError(detail, status);
  if (status === 409) {
    // The computer says which kind of 409 this is. Absent, it is the ordinary one.
    if (body?.humanHasControl === true) {
      throw new HumanHasControlError(
        detail,
        typeof body.requestId === "string" ? body.requestId : undefined,
        body.handoff && typeof body.handoff === "object"
          ? (body.handoff as HandoffRequest)
          : undefined,
      );
    }
    throw new StaleSnapshotError(detail, body?.snapshotRequired === true);
  }
  if (status === 403) {
    throw new WorkspaceRefusedError(detail);
  }
  if (status === 400) {
    throw new WorkspaceRequestError(detail);
  }
  if (status === 404) {
    throw new WorkspaceNotFoundError(detail);
  }
  if (status === 413) {
    throw new WorkspaceTooLargeError(detail);
  }
  if (/waiting for locator|Timeout .* exceeded/i.test(detail)) {
    const ref = detail.match(/aria-ref=([A-Za-z0-9_-]+)/)?.[1];
    throw new ElementNotFoundError(
      `${ref ? `Element ${ref} is` : "That element is"} not on the page any more. Take a fresh snapshot and use the refs from it.`,
    );
  }
  throw new ComputerUnavailableError(detail);
}
