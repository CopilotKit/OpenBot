import type {
  ActionResult,
  ClickInput,
  ComputerProfile,
  ComputerStatus,
  ControlState,
  HumanInput,
  HumanInputResult,
  KeyInput,
  ListFilesInput,
  ListFilesResult,
  NavigateResult,
  ReadFileInput,
  ReadFileResult,
  ReadResult,
  ScreenshotResult,
  ScrollInput,
  SecretRequest,
  SecretResult,
  SnapshotResult,
  TypeInput,
  WriteFileInput,
  WriteFileResult,
} from "./schema";
import { checkComputerAddress, checkNavigationTarget } from "./target";

/**
 * How the server talks to a Bot's computer.
 *
 * The computer has no authentication of its own and trusts whatever reaches it, so this module is
 * the boundary: it decides whether a navigation is permitted before the request leaves, and it is
 * the only place that knows the computer's address. Nothing downstream of here should be handed a
 * raw URL from a model.
 */

export type ComputerClientOptions = {
  /**
   * The secret this deployment's computers require. Absent means every call is refused by them, which
   * is the correct failure: a computer that answers an unauthenticated caller is the bug.
   */
  token?: string;
  /** Base URL of the Bot's computer, e.g. http://agent-computer:4100 */
  baseUrl: string;
  /**
   * Where this Bot's computer is, when each Bot has one of its own.
   *
   * A supervisor gives every Bot its own container, so the address stops being one fixed URL and becomes
   * whatever the supervisor published for that Bot, which also changes when its computer is reset.
   * Left unset, `baseUrl` answers for everyone as one shared computer.
   */
  resolveBaseUrl?: (botId: string) => Promise<string>;
  /** True on a laptop, where browsing the deployment's own services is the point. */
  allowPrivateHosts?: boolean;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

export class ComputerUnavailableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "ComputerUnavailableError";
  }
}

/**
 * The Bot acted on something that is not on the page.
 *
 * Its own error because it is its own condition, and the one the Bot can fix by taking a fresh
 * snapshot.
 *
 * The message a locator failure carries is a Playwright call log, several lines of `waiting for
 * locator('aria-ref=e5')`, which is noise to a model and to a person. It is replaced with the thing
 * to do next.
 */
export class ElementNotFoundError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "ElementNotFoundError";
  }
}

export class NavigationRefusedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "NavigationRefusedError";
  }
}

/**
 * The file request itself was refused by the computer: outside the workspace, missing, or too large.
 *
 * Distinct from a policy refusal, which happens in the gateway before the request is ever made. Both
 * reach the browser as a 403 but they mean different things: this one says the path is not a thing a
 * Bot may name at all, the other says this Bot may not touch an otherwise perfectly valid path. Only
 * the second has a rule an administrator can go and edit.
 */
export class WorkspaceRefusedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "WorkspaceRefusedError";
  }
}

/**
 * The request asked for something that is not there, or not usable: no such file, a folder where a
 * file was wanted, a write that is too big.
 *
 * Not a refusal. Nothing declined to let the Bot do this; the thing it named does not fit the request.
 * Kept separate from {@link WorkspaceRefusedError} because a Bot's next move differs completely: here
 * it should look at what IS there and try again, whereas a refusal is final and should be reported.
 */
export class WorkspaceRequestError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "WorkspaceRequestError";
  }
}

/**
 * The refs the caller is using were taken before the page changed.
 *
 * Its own type because it is the one failure here that the model can fix without a person: take a new
 * snapshot and try again. Collapsed into a generic failure, the Bot apologises to the person instead.
 */
export class StaleSnapshotError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "StaleSnapshotError";
  }
}

export function createComputerClient(options: ComputerClientOptions) {
  const doFetch = options.fetchImpl ?? fetch;
  /*
   * The secret the computer demands. Without it this process is just another caller, which is the
   * point: a computer that answers without this token bypasses the policy gateway, audit trail, and
   * sign-in boundary.
   */
  const token = options.token;
  const timeoutMs = options.timeoutMs ?? 45_000;
  const base = options.baseUrl.replace(/\/$/, "");

  /**
   * A view of the computer as one Bot.
   *
   * Which Bot is asking has to reach the computer, or nothing on the far side can be per-Bot: its
   * profile, its logins, the proxy its traffic leaves through and who holds its wheel all key off this
   * one string. If the id is omitted, every Bot resolves the same fixed default and per-Bot settings
   * such as `EGRESS_PROXY_<BOT>` cannot apply.
   *
   * A bound view rather than a parameter on twenty methods: the gateway already knows the Bot at the
   * point it acts, and threading it through every signature would put the same argument in every call
   * site for a value that never changes within a request.
   */
  function build(botId?: string) {
    async function call(
      path: string,
      init?: RequestInit,
      caller?: AbortSignal,
    ): Promise<unknown> {
      // Resolved per call rather than held, because a computer that was reset comes back on a
      // different port and a cached address would point at nothing.
      //
      // Outside the try below on purpose: that catch reports "the computer is not running", which is
      // true of a computer that will not answer and misleading about a supervisor that could not be
      // reached or refused. Those are different operator-facing problems.
      let target: string;
      if (botId && options.resolveBaseUrl) {
        const located = (await options.resolveBaseUrl(botId)).replace(
          /\/$/,
          "",
        );
        // Checked because this address is not necessarily ours. A hosted provider answers from its
        // own API, and whatever comes back is about to be called with this deployment's computer
        // token. Our own supervisor answers with a private address, which is fine and why this is
        // not the navigation check.
        const verdict = checkComputerAddress(located);
        if (!verdict.allowed) {
          throw new ComputerUnavailableError(verdict.reason);
        }
        target = located;
      } else {
        target = base;
      }

      // Already stopped before this left: do not dispatch at all. Relying on fetch to reject an
      // aborted signal makes "did the click happen" depend on how quickly the runtime notices, and
      // the answer to "the person pressed Stop first" should never be a race.
      if (caller?.aborted) {
        throw new ComputerUnavailableError("The action was stopped.");
      }

      let response: Response;
      try {
        response = await doFetch(`${target}${path}`, {
          ...init,
          // The Bot's identity, as a header rather than in the path, so the computer's published routes
          // are unchanged and a caller that does not know which Bot it is still works.
          headers: {
            ...(init?.headers as Record<string, string> | undefined),
            ...(botId ? { "x-openbot-bot-id": botId } : {}),
            ...(token ? { "x-openbot-computer-token": token } : {}),
          },
          /*
           * Both reasons to give up. The timeout protects the server from a computer that
           * has stopped answering; `caller` is the person pressing Stop, and it has to reach the
           * browser or the click they were stopping still lands. Combined rather than chosen between:
           * whichever fires first ends the request.
           */
          signal: caller
            ? AbortSignal.any([caller, AbortSignal.timeout(timeoutMs)])
            : AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        // Distinguished from a failed page load on purpose: this one means the computer itself is not
        // there, which is an operator problem, not something the person asking can fix by rephrasing.
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
        const detail =
          typeof body?.error === "string"
            ? body.error
            : `HTTP ${response.status}`;
        // A stale ref is fixed by taking a new snapshot, so it is not reported as the computer being
        // unavailable.
        if (response.status === 409) {
          throw new StaleSnapshotError(detail);
        }
        // These two must not be collapsed: path confinement and ordinary bad requests lead to
        // different next actions.
        // 403 is the path confinement: a boundary, and the answer will never change.
        if (response.status === 403) {
          throw new WorkspaceRefusedError(detail);
        }
        // 400 is an ordinary bad request: no such file, a folder where a file was wanted, too large. A
        // different request would succeed, which is exactly what the Bot needs to understand.
        if (response.status === 400) {
          throw new WorkspaceRequestError(detail);
        }
        /*
         * A locator that never resolved is not an outage. Playwright reports it as a timeout whose
         * message is a call log naming the selector, which is how "that button is not there" ended up
         * indistinguishable from "the computer is down".
         */
        if (/waiting for locator|Timeout .* exceeded/i.test(detail)) {
          const ref = detail.match(/aria-ref=([A-Za-z0-9_-]+)/)?.[1];
          throw new ElementNotFoundError(
            `${ref ? `Element ${ref} is` : "That element is"} not on the page any more. Take a fresh snapshot and use the refs from it.`,
          );
        }
        throw new ComputerUnavailableError(detail);
      }
      return body;
    }

    async function post(
      path: string,
      payload: unknown,
      caller?: AbortSignal,
    ): Promise<unknown> {
      return call(
        path,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        },
        caller,
      );
    }

    return {
      async status(botId: string): Promise<ComputerStatus> {
        try {
          await call("/health");
          return { botId, state: "ready" };
        } catch (error) {
          return {
            botId,
            state: "unreachable",
            reason: error instanceof Error ? error.message : "Unknown failure.",
          };
        }
      },

      /** Open a page. Refuses before the request leaves if the target is not permitted. */
      async navigate(url: string): Promise<NavigateResult> {
        const verdict = checkNavigationTarget(url, {
          allowPrivateHosts: options.allowPrivateHosts,
        });
        if (!verdict.allowed) {
          throw new NavigationRefusedError(verdict.reason);
        }

        return (await call("/navigate", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url: verdict.url }),
        })) as NavigateResult;
      },

      async screenshot(): Promise<ScreenshotResult> {
        return (await call("/screenshot")) as ScreenshotResult;
      },

      /** The current page as text. No navigation, so no target check applies. */
      async read(): Promise<ReadResult> {
        return (await call("/read")) as ReadResult;
      },

      async snapshot(): Promise<SnapshotResult> {
        return (await call("/snapshot", { method: "POST" })) as SnapshotResult;
      },

      /**
       * The acting calls.
       *
       * Deliberately unguarded here. Unlike `navigate`, which checks its target in this module, these
       * carry no policy of their own: the gateway in front of them is the only thing that knows which
       * Bot is asking and what the deployment allows, and putting a second half-check here would create
       * two places to keep in agreement. Never call these directly from a route.
       */
      async click(
        input: ClickInput,
        caller?: AbortSignal,
      ): Promise<ActionResult> {
        return (await post("/click", input, caller)) as ActionResult;
      },

      async type(
        input: TypeInput,
        caller?: AbortSignal,
      ): Promise<ActionResult> {
        return (await post("/type", input, caller)) as ActionResult;
      },

      async key(input: KeyInput, caller?: AbortSignal): Promise<ActionResult> {
        return (await post("/key", input, caller)) as ActionResult;
      },

      async scroll(
        input: ScrollInput,
        caller?: AbortSignal,
      ): Promise<ActionResult> {
        return (await post("/scroll", input, caller)) as ActionResult;
      },

      /**
       * The workspace files. Also unguarded here: the computer confines the path to the workspace, and
       * the gateway decides whether this Bot may touch it. Two questions, neither answered in this file.
       */
      async readFile(input: ReadFileInput): Promise<ReadFileResult> {
        return (await post("/files/read", input)) as ReadFileResult;
      },

      async writeFile(input: WriteFileInput): Promise<WriteFileResult> {
        return (await post("/files/write", input)) as WriteFileResult;
      },

      async listFiles(input: ListFilesInput): Promise<ListFilesResult> {
        return (await post("/files/list", input)) as ListFilesResult;
      },

      /** Who has the wheel, and whether the Bot is waiting for a person. */
      async control(): Promise<ControlState> {
        return (await call("/control")) as ControlState;
      },

      async requestControl(reason: string): Promise<ControlState> {
        return (await post("/control/request", { reason })) as ControlState;
      },

      async takeControl(): Promise<ControlState> {
        return (await post("/control/take", {})) as ControlState;
      },

      async releaseControl(): Promise<ControlState> {
        return (await post("/control/release", {})) as ControlState;
      },

      /**
       * A person's own mouse and keyboard, straight through.
       *
       * Deliberately NOT governed by the policy gateway. The policy exists to constrain what a BOT may
       * do; a person taking the wheel is the escape hatch that makes a governed Bot usable at all, and
       * a rule that could lock somebody out of their own browser mid-login would be a worse failure
       * than anything it prevented. The takeover itself is audited as an event; the keystrokes are not.
       */
      /** Ask for a secret. Carries the label and the field, never a value. */
      async requestSecret(input: SecretRequest): Promise<ControlState> {
        return (await post("/control/secret", input)) as ControlState;
      },

      /**
       * Supply one. The value passes through this call and is kept nowhere: not returned upward, not
       * logged here, and not written to the audit trail by the gateway.
       */
      /** The computers this process holds, running or not. */
      async computers(): Promise<{ computers: ComputerProfile[] }> {
        return (await call("/computers")) as { computers: ComputerProfile[] };
      },

      /** Stop the browser and keep what it knows. */
      async stopComputer(): Promise<{ stopped: boolean; wasRunning: boolean }> {
        return (await post("/computers/stop", {})) as {
          stopped: boolean;
          wasRunning: boolean;
        };
      },

      /** Delete the profile. Every login the Bot had goes with it. */
      async resetComputer(): Promise<{ reset: boolean; botId: string }> {
        return (await post("/computers/reset", {})) as {
          reset: boolean;
          botId: string;
        };
      },

      async supplySecret(text: string): Promise<SecretResult> {
        return (await post("/human/secret", { text })) as SecretResult;
      },

      async humanInput(input: HumanInput): Promise<HumanInputResult> {
        const { kind, ...rest } = input;
        return (await post(`/human/${kind}`, rest)) as HumanInputResult;
      },

      /** The same computer, addressed as a particular Bot. */
      forBot(id: string) {
        return build(id);
      },
    };
  }

  return build();
}

export type ComputerClient = ReturnType<typeof createComputerClient>;
