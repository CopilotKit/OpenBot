import { serve } from "bun";
import { join } from "node:path";
import { isOpenPath, matchesToken, offeredToken } from "./authorisation";
import {
  type BrowserComputer,
  type BrowserManager,
  type BrowserStream,
  StaleSnapshotError,
} from "./browser";
import {
  type Control,
  ControlError,
  ControlRequestError,
  createControl,
  NO_SECRET_PENDING,
  TAKE_CONTROL_FIRST,
} from "./control";
import { createCuaBrowserManager, type CuaDriver } from "./cua-browser";
import { identity } from "./identity";
import { createPlaywrightBrowserManager } from "./playwright-browser";
import type { InputMessage } from "./screencast";
import {
  createWorkspace,
  WorkspaceFileError,
  WorkspacePathError,
} from "./workspace";
import { createShell } from "./shell";

/**
 * The Bot's computer: one long-lived browser, reachable over HTTP.
 *
 * Acting on a page lives in this process because only this process holds the browser. In the
 * intended deployment path, the server gateway decides whether an action may run and records the
 * audit row before calling this process. This process has no policy engine and no audit trail of its
 * own; its direct-port boundary is the computer token.
 *
 * `/files/read` and `/files/write` reach the durable workspace volume, confined to
 * it by workspace.ts. Reading and writing are the two operations a Bot needs to keep notes between
 * turns.
 *
 * Elements are addressed by reference, not by pixel. `/snapshot` stamps every interactive element
 * with a ref and hands back a compact list; `/click` and `/type` take one of those refs. That is the
 * accessibility-tree-first driver this is built on, and it is why filling in a form needs no
 * vision model at all: the Bot reads a list of fields rather than squinting at a picture and guessing
 * coordinates. Pixels remain the eventual fallback for canvas-style pages that expose no elements.
 *
 * One browser stays open so state survives between
 * turns: a session it signed into an hour ago is still signed in now. Launching per request would
 * make every task start from a cold, logged-out browser, which is the behaviour we are specifically
 * trying not to have.
 *
 * It authenticates its caller: every request must present the secret below, and the process refuses
 * to start without one. That is a lock on the door rather than a reason to put the door somewhere
 * public. It still belongs on the deployment network, behind the server that decides who is asking.
 */

/**
 * The secret every caller must present.
 *
 * This process drives a browser that holds real logins. Policy, audit, actor identity and SPIFFE
 * identity live in the server and are not on the direct computer port.
 *
 * Refusing to start without a token makes missing authentication a deployment failure, never an open
 * computer.
 */
const COMPUTER_TOKEN = process.env.COMPUTER_TOKEN?.trim();
if (!COMPUTER_TOKEN) {
  console.error(
    "COMPUTER_TOKEN is not set. This process drives a browser holding real logins and will not start without the secret its caller must present.",
  );
  process.exit(1);
}

const PORT = Number.parseInt(process.env.PORT ?? "4100", 10);
const NAVIGATION_TIMEOUT_MS = Number.parseInt(
  process.env.NAVIGATION_TIMEOUT_MS ?? "30000",
  10,
);

/**
 * How long one action waits for its element.
 *
 * Much shorter than a navigation. Playwright waits for a control to become clickable, which is the
 * behaviour we want, but a ref that no longer resolves would otherwise hang for the full navigation
 * timeout before saying so, and the person is sitting watching a screen that is not changing.
 */
const ACTION_TIMEOUT_MS = Number.parseInt(
  process.env.ACTION_TIMEOUT_MS ?? "10000",
  10,
);

/** Per-Bot browser-control state. Profiles are isolated, but this process is not a security boundary. */
type BotSession = {
  control: Control;
  /** The one live screen viewer for this Bot, if a person is watching. */
  viewer?: {
    socket: unknown;
    cast: BrowserStream;
  };
};

const sessions = new Map<string, BotSession>();

function sessionFor(botId: string): BotSession {
  const existing = sessions.get(botId);
  if (existing) return existing;
  const created: BotSession = { control: createControl() };
  sessions.set(botId, created);
  return created;
}

/**
 * Sent by the server as a header on every call. Absent means the caller does not know or does not
 * care, such as a health check, and that gets the default computer rather than an error, because
 * refusing it would make the container undemonstrable on its own.
 */
function botIdOf(request: Request, fallback?: string | null): string {
  return (
    request.headers.get("x-openbot-bot-id")?.trim() ||
    fallback?.trim() ||
    DEFAULT_BOT_ID
  );
}

/**
 * The Bot's durable files.
 *
 * Rooted at WORKSPACE_DIR, which the image creates and docker-compose mounts as a volume, so what a
 * Bot saves outlives the container. Built once at boot: the root is fixed, and resolving it per request
 * would only add a syscall to every call. Everything about why confinement is harder than it looks
 * lives in workspace.ts.
 */
const workspace = createWorkspace(process.env.WORKSPACE_DIR ?? "/workspace");

/**
 * Who has the wheel, as a state machine in its own module.
 *
 * The state machine lives in `control.ts` so it can be tested without importing Playwright.
 */

// Rooted in the same workspace the file tools use, so a command and a written file see one
// directory rather than two.
const shell = createShell(process.env.WORKSPACE_DIR ?? "/workspace");

/**
 * The id normally arrives as a header on every request. This is the fallback for a caller that has no
 * Bot to name, such as a health check, so the container stays demonstrable on its own rather than
 * refusing everything that is not the server.
 */
const DEFAULT_BOT_ID = process.env.COMPUTER_BOT_ID ?? "shared";

const profileRoot = process.env.PROFILES_DIR ?? "/profiles";
const requestedBackend = process.env.COMPUTER_BACKEND?.trim() || "playwright";
let browsers: BrowserManager;
if (requestedBackend === "cua-driver") {
  const cuaProfileRoot =
    process.env.CUA_DRIVER_BROWSER_PROFILE_ROOT?.trim() ||
    join(profileRoot, "cua-driver");
  // The native library reads this variable directly. The package scripts and Docker entrypoint set
  // it before Bun starts; assigning it here also keeps Node-compatible hosts and injected SDKs
  // aligned with the directory used for list/reset operations.
  process.env.CUA_DRIVER_BROWSER_PROFILE_ROOT = cuaProfileRoot;
  const [{ CuaDriver: NativeCuaDriver }, { chromium }] = await Promise.all([
    import("@trycua/cua-driver"),
    import("playwright"),
  ]);
  browsers = createCuaBrowserManager(
    cuaProfileRoot,
    NativeCuaDriver.create(undefined) as CuaDriver,
    chromium.executablePath(),
  );
} else if (requestedBackend === "playwright") {
  browsers = createPlaywrightBrowserManager(profileRoot, {
    actionTimeoutMs: ACTION_TIMEOUT_MS,
    navigationTimeoutMs: NAVIGATION_TIMEOUT_MS,
  });
} else {
  throw new Error(
    `COMPUTER_BACKEND must be "playwright" or "cua-driver", got ${JSON.stringify(requestedBackend)}.`,
  );
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * One live viewer at a time per Bot, so a reconnect replaces rather than stacks, and two people
 * watching two different Bots do not fight over one cast.
 *
 * A second cast on the same page would have Chrome encoding every frame twice and both sockets acking
 * independently, which stalls both. One person drives; one cast.
 */
async function stopViewer(session: BotSession): Promise<void> {
  const current = session.viewer;
  session.viewer = undefined;
  await current?.cast.stop();
}

/** What a live-screen socket carries: the Bot whose screen it is showing. */
type StreamData = { botId: string };

serve<StreamData>({
  port: PORT,
  idleTimeout: 120,
  /**
   * The live screen, pushed by Chrome rather than polled.
   *
   * Upgraded here rather than served as HTTP because the whole point is that frames arrive when the
   * page changes and input goes back over the same connection. See screencast.ts for why polling was
   * not good enough once a person had to type into this.
   */
  websocket: {
    async open(ws) {
      const session = sessionFor(ws.data.botId);
      try {
        await stopViewer(session);

        const send = (frame: unknown) => {
          // A closed socket starts a fresh cast on the next connection.
          try {
            ws.send(JSON.stringify(frame));
          } catch {
            if (session.viewer?.socket === ws) void stopViewer(session);
          }
        };

        const cast = await browsers.computer(ws.data.botId).startStream(send);
        session.viewer = { socket: ws, cast };
      } catch (error) {
        ws.send(
          JSON.stringify({
            type: "error",
            error: describe(error, "The screen could not be started."),
          }),
        );
        ws.close();
      }
    },

    async message(ws, raw) {
      const session = sessionFor(ws.data.botId);
      if (!session.viewer || session.viewer.socket !== ws) return;
      let message: InputMessage;
      try {
        message = JSON.parse(String(raw)) as InputMessage;
      } catch {
        return;
      }
      // A person's input is accepted only while they hold the wheel. The socket being open is not permission:
      // without this check, anything that could reach this port could drive the browser while a Bot
      // was working, which is the one thing the control state exists to prevent.
      //
      // Refuse with an error so the surface can explain why input is ignored.
      if (!session.control.humanMayDrive()) {
        ws.send(JSON.stringify({ type: "error", error: TAKE_CONTROL_FIRST }));
        return;
      }
      try {
        await session.viewer.cast.send(message);
      } catch (error) {
        // Reported rather than swallowed. A dispatch that fails means the person's input did nothing,
        // and they must not be left believing it landed.
        console.error(
          JSON.stringify({
            type: "screencast-input-error",
            message: message.type,
            error: String(error),
          }),
        );
        ws.send(
          JSON.stringify({
            type: "error",
            error: describe(error, "That input could not be applied."),
          }),
        );
      }
    },

    async close(ws) {
      const session = sessionFor(ws.data.botId);
      if (session.viewer?.socket === ws) await stopViewer(session);
    },
  },
  async fetch(request, server) {
    const url = new URL(request.url);

    /*
     * Nothing below this line happens for an untrusted caller.
     *
     * `/health` is the single exception: it names no Bot, touches no browser and reports nothing but
     * whether this process is up, and a container orchestrator has to be able to ask that without
     * holding a secret.
     *
     * The websocket upgrade is checked here too. A browser cannot set headers on an upgrade, so the
     * stream carries the token as a query
     * parameter the same way it already carries the Bot.
     */
    if (
      !isOpenPath(url.pathname) &&
      !matchesToken(COMPUTER_TOKEN, offeredToken(request.headers, url))
    ) {
      // Says nothing about what is here. A refusal that describes the endpoint it is protecting is a
      // directory listing for whoever is knocking.
      return json({ error: "Not authorised." }, 401);
    }

    // Resolved once per request. Everything below that touches a browser, a takeover or a snapshot
    // goes through this Bot's session, so there is no path where one Bot's call reaches another's.
    const botId = botIdOf(request);
    const session = sessionFor(botId);

    if (url.pathname === "/stream") {
      /*
       * The socket carries the Bot in the query because it cannot do it in a header. Every other call here names
       * its Bot in `x-openbot-bot-id`, but a websocket client sends no custom headers on the upgrade,
       * so the stream, and only the stream, also accepts the Bot as a query parameter. The header
       * still wins where there is one.
       */
      const streamBotId = botIdOf(request, url.searchParams.get("bot"));
      if (server.upgrade(request, { data: { botId: streamBotId } }))
        return undefined as unknown as Response;
      return json({ error: "Expected a WebSocket upgrade." }, 400);
    }

    /*
     * `/live` stays absent. A page served by this process can only be opened by putting the secret in
     * a URL, where it lands in history and logs. The React app is the guarded way to watch a Bot.
     */

    // Who has the wheel. Polled by the surface alongside the screen, so the person sees the Bot ask
    // for help without having to reload anything.
    if (url.pathname === "/control" && request.method === "GET") {
      return json(session.control.get());
    }

    // The Bot asking for help. It does not take control: it says it is stuck and why, and a person
    // decides. A Bot that could hand itself to a human could also hand a human a page they never
    // asked to see.
    if (url.pathname === "/control/request" && request.method === "POST") {
      const body = (await request.json().catch(() => null)) as {
        reason?: unknown;
      } | null;
      return json(session.control.requestHelp(body?.reason));
    }

    // The Bot asking for one value it must not be told. It has already focused the field.
    if (url.pathname === "/control/secret" && request.method === "POST") {
      const body = (await request.json().catch(() => null)) as {
        label?: unknown;
        ref?: unknown;
        snapshotId?: unknown;
      } | null;
      try {
        return json(session.control.requestSecret(body ?? {}));
      } catch (error) {
        if (error instanceof ControlRequestError) {
          return json({ error: error.message }, 400);
        }
        throw error;
      }
    }

    /**
     * A person supplying that value.
     *
     * Scoped by the pending request rather than by a control handover: it is usable only while the Bot
     * has actually asked for a secret, and the request is cleared the moment it is answered, so this
     * cannot be used as a general back door to type into the page.
     *
     * The value is typed and forgotten. Not stored on `control`, not returned in the response, not
     * logged. The response says how many characters arrived, which is enough for the surface to
     * confirm something was sent and useless to anybody reading it later.
     *
     * It types and does not submit. Committing a form is a separate action through the gateway and
     * audit trail; secret entry only places the value in the named field.
     */
    if (url.pathname === "/human/secret" && request.method === "POST") {
      const pending = session.control.pendingSecret();
      if (!pending) {
        return json({ error: NO_SECRET_PENDING }, 409);
      }
      const body = (await request.json().catch(() => null)) as {
        text?: unknown;
      } | null;
      if (typeof body?.text !== "string" || !body.text) {
        return json({ error: "A value is required." }, 400);
      }
      try {
        // No generation check here: a Bot may take another snapshot after asking for a secret. Both
        // backends still resolve the ref against the current page and fail without typing if the
        // target is gone.
        const result = await browsers
          .computer(botId)
          .enterSecret(pending.ref, body.text);
        // Cleared only after it actually landed, so a failure leaves the request open and the person
        // can try again rather than being told to start over.
        session.control.secretSupplied();
        return json({ supplied: true, ...result });
      } catch (error) {
        if (error instanceof StaleSnapshotError) {
          return json({ error: error.message, stale: true }, 409);
        }
        // The field is gone, which is unretryable, so the request is closed rather than left open.
        // Keeping it open is right for a mistyped value and wrong here: the person would retype their
        // password into the same dead ref for ever. Clearing it also unblocks the Bot, which can see
        // on its next turn that nothing is pending and ask again against a fresh snapshot.
        session.control.secretSupplied();
        return json(
          {
            error: describe(
              error,
              "That value could not be entered: the field is no longer on the page. Ask the assistant to request it again.",
            ),
          },
          502,
        );
      }
    }

    if (url.pathname === "/control/take" && request.method === "POST") {
      return json(session.control.take());
    }

    if (url.pathname === "/control/release" && request.method === "POST") {
      // `reason` is dropped on release: it described the thing the person was asked to do, and once
      // they have done it, leaving it set would have the surface still showing the old request.
      return json(session.control.release());
    }

    // A person's input, by pixel. The Bot addresses elements by reference because it reads a list; a
    // person addresses them by pointing, because they are looking at a picture. Different problem,
    // different endpoint, and only usable while they hold the wheel.
    if (HUMAN_INPUT.has(url.pathname) && request.method === "POST") {
      if (!session.control.humanMayDrive()) {
        return json({ error: TAKE_CONTROL_FIRST }, 409);
      }
      const body = (await request.json().catch(() => null)) as Record<
        string,
        unknown
      > | null;
      try {
        return json(
          await performHumanInput(
            browsers.computer(botId),
            url.pathname,
            body ?? {},
          ),
        );
      } catch (error) {
        return json({ error: describe(error, "That did not work.") }, 502);
      }
    }

    if (url.pathname === "/health") {
      const [profile] = browsers.summary([botId]);
      return json({
        status: "ok",
        // `browser` kept as it was: it is in the published contract and start.sh reads it.
        browser: profile?.running ?? false,
        backend: browsers.backend,
        profile,
        // Which Bot this computer can prove it is, when the deployment runs SPIRE. Null is a
        // deployment without it, not a failure, and it is reported rather than omitted so the
        // difference between "no identity here" and "identity broken" is visible.
        identity: await identity(),
      });
    }

    /**
     * The computers this process holds. The shape is a list because the admin surface is a
     * list, and because a Bot that has a profile has a computer whether or not a browser is running
     * for it this second.
     */
    if (url.pathname === "/computers" && request.method === "GET") {
      return json({ computers: browsers.summary(await browsers.known()) });
    }

    /**
     * Stop the browser, keep what it knows.
     *
     * Closed gracefully so Chromium flushes its profile, and deliberately
     * not restarted here: the next request starts it again, which is the same path as a first ever
     * start, so there is no second way for a browser to come into existence.
     */
    if (url.pathname === "/computers/stop" && request.method === "POST") {
      const wasRunning = await browsers.stop(botId);
      // The wheel goes back to the Bot because the controlled browser no longer exists.
      session.control.release();
      return json({ stopped: true, wasRunning });
    }

    /**
     * Forget everything and start over.
     *
     * Signs the computer out of everything by deleting the profile. Irreversible, which is why it is
     * its own endpoint rather than a flag on the one above: a person clicking "stop" must not be able
     * to discard a login by mistyping a parameter.
     */
    if (url.pathname === "/computers/reset" && request.method === "POST") {
      await browsers.reset(botId);
      // Reset releases control because any previous browser session and pending secret request are gone.
      session.control.release();
      return json({ reset: true, botId });
    }

    if (url.pathname === "/navigate" && request.method === "POST") {
      const body = (await request.json().catch(() => null)) as {
        url?: unknown;
      } | null;
      if (typeof body?.url !== "string") {
        return json({ error: "A url is required." }, 400);
      }

      const startedAt = Date.now();
      try {
        session.control.assertBotMayAct();
        const result = await browsers
          .computer(botId)
          .navigate(body.url, request.signal);
        return json({
          ...result,
          elapsedMs: Date.now() - startedAt,
        });
      } catch (error) {
        // A person holding the wheel is not a failed navigation; the Bot should wait.
        if (error instanceof ControlError) {
          return json({ error: error.message, humanHasControl: true }, 409);
        }
        // The page is the Bot's working surface, so a failed navigation is reported rather than
        // thrown: the transcript needs to say what happened, and the browser stays usable.
        return json(
          {
            error:
              error instanceof Error ? error.message : "Navigation failed.",
          },
          502,
        );
      }
    }

    if (url.pathname === "/screenshot" && request.method === "GET") {
      try {
        return json(await browsers.computer(botId).screenshot());
      } catch (error) {
        return json(
          {
            error:
              error instanceof Error ? error.message : "Screenshot failed.",
          },
          502,
        );
      }
    }

    // The Bot's files. Confined to the workspace by workspace.ts. Nothing here decides whether a Bot
    // MAY touch a path: the gateway in front of this process does that.
    if (url.pathname === "/files/read" && request.method === "POST") {
      const body = (await request.json().catch(() => null)) as {
        path?: unknown;
      } | null;
      try {
        return json(await workspace.read(String(body?.path ?? "")));
      } catch (error) {
        return json(
          { error: describe(error, "The file could not be read.") },
          fileStatus(error),
        );
      }
    }

    if (url.pathname === "/files/list" && request.method === "POST") {
      const body = (await request.json().catch(() => null)) as {
        path?: unknown;
      } | null;
      try {
        return json(
          await workspace.list(
            typeof body?.path === "string" ? body.path : undefined,
          ),
        );
      } catch (error) {
        return json(
          { error: describe(error, "The folder could not be listed.") },
          fileStatus(error),
        );
      }
    }

    /*
     * A command on this computer.
     *
     * Nothing here decides whether it may run: the gateway already asked the deployment's policy and
     * wrote the audit row before this was called. Refusing again here would be a second, quieter
     * policy nobody configured.
     */
    if (url.pathname === "/exec" && request.method === "POST") {
      const body = (await request.json().catch(() => null)) as {
        command?: unknown;
        timeoutMs?: unknown;
      } | null;
      if (typeof body?.command !== "string" || !body.command.trim()) {
        return json({ error: "A command is required." }, 400);
      }
      try {
        return json(
          await shell.run({
            command: body.command,
            ...(typeof body.timeoutMs === "number"
              ? { timeoutMs: body.timeoutMs }
              : {}),
            signal: request.signal,
          }),
        );
      } catch (error) {
        return json(
          { error: describe(error, "The command could not be run.") },
          500,
        );
      }
    }

    if (url.pathname === "/files/write" && request.method === "POST") {
      const body = (await request.json().catch(() => null)) as {
        path?: unknown;
        contents?: unknown;
        append?: unknown;
      } | null;
      if (typeof body?.contents !== "string") {
        return json({ error: "The contents to write are required." }, 400);
      }
      try {
        return json(
          await workspace.write(String(body?.path ?? ""), body.contents, {
            append: body.append === true,
          }),
        );
      } catch (error) {
        return json(
          { error: describe(error, "The file could not be written.") },
          fileStatus(error),
        );
      }
    }

    // The current page as text, without navigating anywhere.
    //
    // Reading must be available after actions too. Returning page text only from `/navigate` would be enough if
    // opening a page were the only way to change what is on screen. It is not: the Bot presses
    // "Submit order", the page becomes a confirmation, and it has no way to find out what the
    // confirmation said. "I clicked the button" is not an answer to what happened.
    if (url.pathname === "/read" && request.method === "GET") {
      try {
        return json(await browsers.computer(botId).read());
      } catch (error) {
        return json(
          { error: describe(error, "Reading the page failed.") },
          502,
        );
      }
    }

    // The list of things on the page a Bot can act on. POST rather than GET because it mutates the
    // page, stamping every element it describes, and a GET that changes the document is a lie that
    // caches and prefetchers eventually punish.
    if (url.pathname === "/snapshot" && request.method === "POST") {
      try {
        return json(await browsers.computer(botId).snapshot());
      } catch (error) {
        return json({ error: describe(error, "Snapshot failed.") }, 502);
      }
    }

    if (ACTIONS.has(url.pathname) && request.method === "POST") {
      const body = (await request
        .json()
        .catch(() => null)) as ActionBody | null;
      if (!body) {
        return json({ error: "An action needs a JSON body." }, 400);
      }

      const startedAt = Date.now();
      try {
        session.control.assertBotMayAct();
        const detail = await performAction(
          browsers.computer(botId),
          url.pathname,
          body,
          // The caller going away is the stop signal: the surface aborts its request, the server
          // aborts the one it made to this computer, and Bun aborts this one in turn.
          request.signal,
        );
        return json({ ...detail, elapsedMs: Date.now() - startedAt });
      } catch (error) {
        /*
         * Stopped, not failed. The signal is checked rather than the error text: Playwright words an
         * abort differently per call, and the caller's own request going away is the fact that
         * matters either way.
         *
         * Logged because the response is not observed after the caller aborts. The log distinguishes
         * "stopped in time" from "ran to completion after cancellation".
         */
        if (request.signal.aborted) {
          console.info(
            JSON.stringify({
              type: "action-stopped",
              action: url.pathname,
              ref: typeof body.ref === "string" ? body.ref : undefined,
              elapsedMs: Date.now() - startedAt,
            }),
          );
          // 499, the convention for a client that closed the request: this is not the computer
          // failing, and a 502 here would be counted as one.
          return json({ error: "Stopped.", stopped: true }, 499);
        }
        // A stale ref is the caller's mistake and is fixable by taking a new snapshot, so it is a 409
        // rather than a 502: the computer is fine and retrying the same call unchanged will not help.
        if (error instanceof StaleSnapshotError) {
          return json({ error: error.message, stale: true }, 409);
        }
        // 409 as well, and for the same reason: nothing is broken, the caller simply has to wait.
        if (error instanceof ControlError) {
          return json({ error: error.message, humanHasControl: true }, 409);
        }
        return json({ error: describe(error, "The action failed.") }, 502);
      }
    }

    return json({ error: "Not found." }, 404);
  },
});

type ActionBody = {
  ref?: unknown;
  snapshotId?: unknown;
  text?: unknown;
  key?: unknown;
  deltaY?: unknown;
  submit?: unknown;
};

const ACTIONS = new Set(["/click", "/type", "/key", "/scroll"]);

const HUMAN_INPUT = new Set([
  "/human/click",
  "/human/type",
  "/human/key",
  "/human/scroll",
]);

/**
 * Carry out one thing a person did with their mouse or keyboard.
 *
 * Coordinates are viewport pixels, which the surface works out from the screenshot it is displaying:
 * it knows the image's natural size and the size it drew it at, so it can scale a click back. Doing
 * that conversion in the browser rather than here keeps this endpoint bound to page coordinates
 * rather than window coordinates.
 *
 * Nothing a person types here reaches the model. It goes from their keyboard to this browser and
 * stops. That is what makes a password or a one-time code safe to enter during a takeover: not a
 * filter that strips it out afterwards, but a path the model is not on. The same reason the value is
 * never returned and never logged below.
 */
async function performHumanInput(
  computer: BrowserComputer,
  action: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const at = (): { x: number; y: number } => {
    const x = typeof body.x === "number" ? body.x : Number.NaN;
    const y = typeof body.y === "number" ? body.y : Number.NaN;
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error("A click needs an x and a y inside the page.");
    }
    return { x, y };
  };

  if (action === "/human/click") {
    const { x, y } = at();
    return computer.humanClick(x, y);
  }

  if (action === "/human/type") {
    if (typeof body.text !== "string") {
      throw new Error("Typing needs text.");
    }
    // `insertText` rather than per-key typing: a person pasting a one-time code should not have it
    // arrive one character at a time into a field that reformats as you go.
    return computer.humanType(body.text);
  }

  if (action === "/human/key") {
    if (typeof body.key !== "string" || !body.key) {
      throw new Error("A key press needs a key name.");
    }
    return computer.humanKey(body.key);
  }

  const deltaY = typeof body.deltaY === "number" ? body.deltaY : 400;
  return computer.humanScroll(deltaY);
}

/**
 * Carry out one action on the page.
 *
 * Every action that addresses an element goes through the selected backend's ref resolver, so the
 * staleness check cannot be forgotten at a call site. `/key` and `/scroll` may omit a ref and act on
 * the page itself, which is how a Bot presses Enter or scrolls through a long form.
 *
 * Stop has to reach the browser. `signal` is the caller's request going away, the person pressed
 * Stop, and the abort travels from the surface, through the server, to here. Without passing it on,
 * pressing Stop ended the run in the transcript while the click it was meant to prevent carried on
 * landing on a live page. Stop must reach the browser before a high-impact click lands.
 */
async function performAction(
  computer: BrowserComputer,
  action: string,
  body: ActionBody,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const expected =
    typeof body.snapshotId === "number" ? body.snapshotId : undefined;
  const ref = typeof body.ref === "string" && body.ref ? body.ref : undefined;

  if (action === "/click") {
    if (!ref) throw new Error("A click needs the ref of an element to click.");
    return computer.click(ref, expected, signal);
  }

  if (action === "/type") {
    if (!ref) throw new Error("Typing needs the ref of a field to type into.");
    if (typeof body.text !== "string") {
      throw new Error("Typing needs the text to enter.");
    }
    return computer.type(
      ref,
      body.text,
      body.submit === true,
      expected,
      signal,
    );
  }

  if (action === "/key") {
    if (typeof body.key !== "string" || !body.key) {
      throw new Error("A key press needs a key name, such as Enter or Tab.");
    }
    return computer.key(body.key, ref, expected, signal);
  }

  // Scroll. A plain wheel event on the page, which is what moves a long form, rather than scrolling a
  // specific element into view: the Bot asked to see further down, not to hunt for one control.
  const deltaY = typeof body.deltaY === "number" ? body.deltaY : 600;
  return computer.scroll(deltaY, signal);
}

function describe(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/**
 * Which status a file failure deserves.
 *
 * A path outside the workspace is the caller asking for something it may never have, so 403: retrying
 * it unchanged will never work, and it is not a fault. A missing file or an oversized write is a 400,
 * because a different request would succeed. Collapsing both into 500 would tell the Bot the computer
 * is broken and invite it to try the same thing again.
 */
function fileStatus(error: unknown): 400 | 403 | 500 {
  if (error instanceof WorkspacePathError) return 403;
  if (error instanceof WorkspaceFileError) return 400;
  return 500;
}

console.info(
  `agent-computer listening on http://localhost:${PORT} with ${browsers.backend}`,
);

/**
 * Hand the profile back before dying.
 *
 * `docker stop` and a Kubernetes eviction both send SIGTERM and then wait, so this is the window in
 * which Chromium can flush its profile to the volume. This is the graceful-shutdown path for normal
 * container restarts.
 *
 * `stop_grace_period` in docker-compose.yml is what gives this time to run.
 */
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    void (async () => {
      console.info(`${signal}: closing the browser so its profile is flushed`);
      await browsers.closeAll();
      process.exit(0);
    })();
  });
}
