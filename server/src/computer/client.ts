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
  ): Promise<T>;
  post<T>(
    baseUrl: string,
    botId: string,
    path: string,
    payload: unknown,
    caller?: AbortSignal,
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
  const timeoutMs = options.timeoutMs ?? 45_000;

  async function call<T>(
    baseUrl: string,
    botId: string,
    path: string,
    init?: RequestInit,
    caller?: AbortSignal,
  ): Promise<T> {
    if (caller?.aborted) {
      throw new ComputerUnavailableError("The action was stopped.");
    }

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

