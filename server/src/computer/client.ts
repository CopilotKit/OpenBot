import type { NavigateResult } from "./schema";
import { checkNavigationTarget } from "./target";

/** The computer did not accept or answer a request. */
export class ComputerUnavailableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "ComputerUnavailableError";
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

/** The page changed after the caller received its element references. */
export class StaleSnapshotError extends Error {
  constructor(reason: string) {
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
  constructor(reason: string) {
    super(reason);
    this.name = "HumanHasControlError";
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

/** Internal HTTP interface used only by ComputerGateway. */
export interface ComputerTransport {
  call<T>(
    baseUrl: string,
    botId: string,
    path: string,
    init?: RequestInit,
    caller?: AbortSignal,
    /** Overrides the transport's own deadline for this one call. */
    timeoutMs?: number,
  ): Promise<T>;
  post<T>(
    baseUrl: string,
    botId: string,
    path: string,
    payload: unknown,
    caller?: AbortSignal,
    /** Overrides the transport's own deadline for this one call. */
    timeoutMs?: number,
  ): Promise<T>;
  navigate(
    baseUrl: string,
    botId: string,
    url: string,
  ): Promise<NavigateResult>;
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

  async function call<T>(
    baseUrl: string,
    botId: string,
    path: string,
    init?: RequestInit,
    caller?: AbortSignal,
    timeoutMsOverride?: number,
  ): Promise<T> {
    if (caller?.aborted) {
      throw new ComputerUnavailableError("The action was stopped.");
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
          "x-openbot-bot-id": botId,
          ...(options.token
            ? { "x-openbot-computer-token": options.token }
            : {}),
        },
        signal: caller
          ? AbortSignal.any([caller, AbortSignal.timeout(timeoutMs)])
          : AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new ComputerUnavailableError(
        error instanceof Error && error.name === "TimeoutError"
          ? "The assistant's computer did not respond in time."
          : "The assistant's computer is not running.",
      );
    }

    const body = (await response.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!response.ok) {
      throwMappedError(response.status, body);
    }
    return body as T;
  }

  function post<T>(
    baseUrl: string,
    botId: string,
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
    botId: string,
    url: string,
  ): Promise<NavigateResult> {
    const verdict = checkNavigationTarget(url, {
      allowPrivateHosts: options.allowPrivateHosts,
    });
    if (!verdict.allowed) {
      throw new NavigationRefusedError(verdict.reason);
    }
    return post<NavigateResult>(baseUrl, botId, "/navigate", {
      url: verdict.url,
    });
  }

  return { call, post, navigate };
}

/** Map agent-computer responses to errors that a caller can act on. */
function throwMappedError(
  status: number,
  body: Record<string, unknown> | null,
): never {
  const detail =
    typeof body?.error === "string" ? body.error : `HTTP ${status}`;
  if (status === 409) {
    // The computer says which kind of 409 this is. Absent, it is the ordinary one.
    if (body?.humanHasControl === true) {
      throw new HumanHasControlError(detail);
    }
    throw new StaleSnapshotError(detail);
  }
  if (status === 403) {
    throw new WorkspaceRefusedError(detail);
  }
  if (status === 400) {
    throw new WorkspaceRequestError(detail);
  }
  if (/waiting for locator|Timeout .* exceeded/i.test(detail)) {
    const ref = detail.match(/aria-ref=([A-Za-z0-9_-]+)/)?.[1];
    throw new ElementNotFoundError(
      `${ref ? `Element ${ref} is` : "That element is"} not on the page any more. Take a fresh snapshot and use the refs from it.`,
    );
  }
  throw new ComputerUnavailableError(detail);
}
