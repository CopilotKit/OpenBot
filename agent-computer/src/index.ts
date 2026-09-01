import { serve } from "bun";
import type { Page } from "playwright";
import { parseAriaSnapshot, type SnapshotElement } from "./aria-snapshot";
import {
  actsOnTheComputer,
  isOpenPath,
  matchesToken,
  offeredToken,
} from "./authorisation";
import { isPlainBotId } from "./bot-id";
import {
  type Control,
  ControlError,
  ControlRequestError,
  createControl,
  NO_SECRET_PENDING,
  TAKE_CONTROL_FIRST,
} from "./control";
import {
  type DesktopMode,
  desktopCapability,
  desktopMode,
  desktopUpstream,
} from "./desktop";
import { identity } from "./identity";
import { createProfiles, numberFromEnv, VIEWPORT } from "./profiles";
import { type InputMessage, startScreencast } from "./screencast";
import { createShell } from "./shell";
import { createViewerSlot, type ViewerSlot } from "./viewer";
import {
  createWorkspace,
  WorkspaceFileError,
  WorkspacePathError,
} from "./workspace";

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

const PORT = numberFromEnv("PORT", 4100);
const NAVIGATION_TIMEOUT_MS = numberFromEnv("NAVIGATION_TIMEOUT_MS", 30000);

/**
 * How long one action waits for its element.
 *
 * Much shorter than a navigation. Playwright waits for a control to become clickable, which is the
 * behaviour we want, but a ref that no longer resolves would otherwise hang for the full navigation
 * timeout before saying so, and the person is sitting watching a screen that is not changing.
 */
const ACTION_TIMEOUT_MS = numberFromEnv("ACTION_TIMEOUT_MS", 10000);

/**
 * How much page text a navigation hands back.
 *
 * Bounded because a page can be megabytes and the text goes into a model's context, where a single
 * unbounded page can push the rest of the conversation out. Generous enough that the visible part of
 * an ordinary page arrives whole, which is what the answer is usually made of.
 */
const TEXT_EXTRACT_LIMIT = 6000;

/**
 * Which snapshot the caller's refs came from.
 *
 * Kept as a caller-facing guard even though Playwright enforces the real thing underneath. The
 * published tool contract says an action carries the `snapshotId` it got, and a mismatch is answered
 * with "take a new snapshot", which is a clearer message for a model than an element that merely fails
 * to resolve. Playwright's `aria-ref` engine is the runtime enforcement: it resolves a ref only against
 * the most recent snapshot, only while the element is still connected to the document, and it mints a
 * new ref if an element's role or accessible name changed, so a recycled node cannot inherit an old one.
 */
/** Per-Bot browser-control state. Profiles are isolated, but this process is not a security boundary. */
type BotSession = {
  control: Control;
  /** This Bot's snapshot generation. See the note above on staleness. */
  snapshotId: number;
  /** The page this Bot was last handed, so a change of page can retire its refs. */
  livePage?: Page;
  /**
   * This Bot's live screen, and who owns it.
   *
   * Always present, because the slot is the answer to "is anybody watching" as well as the holder of
   * whoever is. An empty slot is a Bot nobody is watching; there is no second way to say that.
   */
  viewer: ViewerSlot;
};

const sessions = new Map<string, BotSession>();

/**
 * Forget the sessions of Bots whose browsers are no longer running.
 *
 * The map gained an entry per Bot id this process had ever seen and lost none, so a deployment where
 * every employee has a Bot accumulated one small object per employee for the life of the container.
 * Small, but unbounded, which is the same shape as the browsers themselves.
 *
 * Only entries with no live browser and nobody watching are dropped: the state is the generation
 * counter and the control handover, and both belong to a running browser. A Bot whose browser has
 * been closed starts a fresh session next time, which is what starting a fresh browser means.
 *
 * "Nobody watching" starts at the claim, not at the first frame. A viewer whose browser is still
 * launching holds a claim and no cast, and reading occupancy from the cast would call that Bot idle
 * for the whole cold launch: this runs on the path that adds a session, so another Bot connecting
 * then would drop the control handover out from under a screen that is seconds from live. It stays
 * occupied until teardown finishes, for the same reason at the other end.
 */
function forgetIdleSessions(): void {
  for (const [botId, session] of [...sessions.entries()]) {
    if (session.viewer.occupied()) continue;
    if (profiles.isLive(botId)) continue;
    sessions.delete(botId);
  }
}

function sessionFor(botId: string): BotSession {
  const existing = sessions.get(botId);
  if (existing) return existing;
  const created: BotSession = {
    control: createControl(),
    snapshotId: 0,
    viewer: createViewerSlot(),
  };
  sessions.set(botId, created);
  // Cheap, and only ever on the path that adds one, so the map cannot grow without this running.
  if (sessions.size > 32) forgetIdleSessions();
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

/**
 * The Bot's browser and the profile that outlives it. See profiles.ts.
 *
 * `chromium.launch()` gives a fresh anonymous profile every time. Persistent profiles live on a
 * mounted volume so sign-in state survives the container.
 */
/**
 * The browsers, and what a closing one takes with it.
 *
 * Every close announces itself here, whether it came from a request, the cap, or the idle sweep, and
 * the live screen watching that Bot comes down with it. Hanging this off the close rather than
 * calling it from the stop and reset handlers is what covers the two closes no request makes: a
 * viewer that outlived one of those kept a 1Hz loop asking for a page, which starts a browser, so
 * the Bot was immune to the idle timeout and came straight back after a cap eviction.
 *
 * `sessions.get`, never `sessionFor`: a Bot with no session has nobody watching, and inventing one
 * here would put an entry in the map on the path that closes browsers, which is where the map is
 * meant to shrink.
 */
const profiles = createProfiles(
  process.env.PROFILES_DIR ?? "/profiles",
  (botId) => sessions.get(botId)?.viewer.releaseAll(COMPUTER_STOPPED),
);
// Rooted in the same workspace the file tools use, so a command and a written file see one
// directory rather than two.
const shell = createShell(process.env.WORKSPACE_DIR ?? "/workspace");

/**
 * The id normally arrives as a header on every request. This is the fallback for a caller that has no
 * Bot to name, such as a health check, so the container stays demonstrable on its own rather than
 * refusing everything that is not the server.
 */
const DEFAULT_BOT_ID = (() => {
  const configured = process.env.COMPUTER_BOT_ID ?? "shared";
  // At boot rather than per request. This is the id every unheadered call falls back to, so a value
  // the path rules refuse would answer 400 to everything and read as a broken computer.
  if (!isPlainBotId(configured)) {
    throw new Error(
      "COMPUTER_BOT_ID may contain only letters, digits, hyphen and underscore, and must start with a letter or digit.",
    );
  }
  return configured;
})();

// A local dock click carries no Bot header. The most recent successful control connection selects
// the profile it belongs to: only a control socket can deliver the click which starts the launcher.
// In per-Bot VM mode there is only one possible value; this also makes shared local development
// deterministic for the person currently holding the wheel.
let activeDesktopBotId = DEFAULT_BOT_ID;
let activeDesktopLease: string | undefined;

async function currentPage(botId: string): Promise<Page> {
  const session = sessionFor(botId);
  const page = await profiles.page(botId);
  // A ref names an element on the page it was taken from, so moving to a window the site opened has
  // to retire the outstanding ones exactly as a navigation does, or a click lands on the wrong document.
  if (session.livePage && session.livePage !== page) session.snapshotId += 1;
  session.livePage = page;
  return page;
}

/**
 * The page as text, the way a reader sees it.
 *
 * Script and style bodies are dropped rather than included: they are the bulk of a modern page and
 * none of it is what anybody asked about, so leaving them in spends the extract on noise and pushes
 * the actual article past the limit.
 */
async function readablePageText(
  target: Page,
): Promise<{ text: string; truncated: boolean }> {
  const raw = await target.evaluate(() => {
    const clone = document.body?.cloneNode(true) as HTMLElement | undefined;
    if (!clone) return "";
    for (const node of clone.querySelectorAll("script, style, noscript, svg")) {
      node.remove();
    }
    return clone.innerText ?? "";
  });

  const collapsed = raw.replace(/\n{3,}/g, "\n\n").trim();
  return {
    text: collapsed.slice(0, TEXT_EXTRACT_LIMIT),
    truncated: collapsed.length > TEXT_EXTRACT_LIMIT,
  };
}

/**
 * Describe everything on the page a Bot can act on.
 *
 * Uses Playwright's AI snapshot rather than stamping attributes into the DOM. `ariaSnapshot` keeps
 * refs outside the page, survives framework re-renders, resolves accessible names, reports current
 * values and checked state, filters to actionable elements and descends into iframes.
 */
async function snapshotPage(
  session: BotSession,
  target: Page,
): Promise<{
  snapshotId: number;
  url: string;
  title: string;
  elements: SnapshotElement[];
  truncated: boolean;
}> {
  session.snapshotId += 1;
  const yaml = await target.ariaSnapshot({ mode: "ai" });
  return {
    snapshotId: session.snapshotId,
    url: target.url(),
    title: await target.title(),
    ...parseAriaSnapshot(yaml),
  };
}

/**
 * Resolve a ref to a locator, refusing anything from a superseded snapshot.
 *
 * `aria-ref=` is a first-party Playwright selector engine, and it is the same one its MCP server uses.
 * The generation check here is the caller-facing half; see the note on `snapshotId` for why both exist.
 */
function locateRef(
  session: BotSession,
  target: Page,
  ref: string,
  expectedSnapshotId: number | undefined,
) {
  if (
    expectedSnapshotId !== undefined &&
    expectedSnapshotId !== session.snapshotId
  ) {
    throw new StaleSnapshotError(
      `That list of elements is out of date: it was taken for snapshot ${expectedSnapshotId} and the page is now at ${session.snapshotId}. Take a new snapshot and use the refs from it.`,
    );
  }
  return target.locator(`aria-ref=${ref}`);
}

/**
 * The element, or a refusal that says what to do about it.
 *
 * A generation check is not an existence check. A ref from
 * the current snapshot that names nothing on the page, because a model invented it or because the
 * page moved on without a new snapshot being taken, passes `locateRef` and then simply waits. The
 * action times out, and the caller gets a generic failure carrying Playwright's internal call log
 * instead of the actionable answer: take a fresh snapshot.
 *
 * `count()` resolves immediately rather than waiting, so a ref that names nothing is refused in
 * milliseconds instead of holding the action open for the full timeout.
 */
async function resolveRef(
  session: BotSession,
  target: Page,
  ref: string,
  expectedSnapshotId: number | undefined,
) {
  const locator = locateRef(session, target, ref, expectedSnapshotId);
  if ((await locator.count()) === 0) {
    throw new StaleSnapshotError(
      `Nothing on this page has the ref ${ref}. Take a new snapshot and use the refs it returns.`,
    );
  }
  return locator;
}

class StaleSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaleSnapshotError";
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** What a person watching is told when the browser they were watching went away. */
const COMPUTER_STOPPED =
  "This computer stopped, so the screen ended. Start it again to carry on watching.";

/** What a person is told when their screen is still opening and they have already started typing. */
const SCREEN_STILL_STARTING =
  "This screen is still starting. Try that again in a moment.";

/** What a person is told when they act on a screen that is no longer theirs, or no longer anything. */
const SCREEN_NO_LONGER_LIVE =
  "This screen is no longer live. Reopen it to carry on watching.";

/** How often the cast checks that it is still showing the page the Bot is on. */
const FOLLOW_INTERVAL_MS = 1_000;

/** The old page cast remains as a compatibility fallback for computers built before full desktop. */
type PageStreamData = { kind: "page"; botId: string; lease?: string };

/** A full desktop connection and the loopback websockify socket it is relaying. */
type DesktopStreamData = {
  kind: "desktop";
  botId: string;
  mode: DesktopMode;
  lease?: string;
  upstream?: WebSocket;
};

type StreamData = PageStreamData | DesktopStreamData;

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
      if (ws.data.kind === "desktop") {
        const session = sessionFor(ws.data.botId);
        if (
          ws.data.mode === "control" &&
          !session.control.humanMayDrive(ws.data.lease)
        ) {
          ws.close(1008, TAKE_CONTROL_FIRST);
          return;
        }

        try {
          // This is a computer connection, not a browser launch. A real VM remains useful with every
          // application closed, and reconnecting its display must not resurrect one a person closed.
          // Bot browser work and the desktop's Browser icon are the two explicit launch paths.
          const upstream = new WebSocket(
            desktopUpstream(ws.data.mode),
            "binary",
          );
          upstream.binaryType = "arraybuffer";
          ws.data.upstream = upstream;
          upstream.onmessage = async (event) => {
            try {
              if (typeof event.data === "string") {
                ws.send(event.data);
              } else if (event.data instanceof ArrayBuffer) {
                ws.send(event.data);
              } else if (event.data instanceof Blob) {
                ws.send(await event.data.arrayBuffer());
              }
            } catch {
              upstream.close();
            }
          };
          upstream.onclose = () => ws.close();
          upstream.onerror = () => ws.close(1011, "The desktop stopped.");
        } catch (error) {
          console.error(
            JSON.stringify({
              type: "desktop-start-error",
              botId: ws.data.botId,
              error: String(error),
            }),
          );
          ws.close(1011, "The desktop could not be started.");
        }
        return;
      }

      const session = sessionFor(ws.data.botId);
      /*
       * Claimed before anything is awaited, and that order is the fix.
       *
       * Below this line the Bot's browser may have to be launched, which takes long enough for a
       * client to connect and go away inside it. A close arriving in that window used to find nothing
       * installed and so did nothing, while this function carried on to install a cast and a 1Hz
       * interval for a socket that had already gone: no second close ever came, and the interval went
       * on relaunching a browser somebody had stopped. With the claim taken first there is always
       * something for that close to release, and everything below goes through the claim and is
       * refused once it is gone.
       */
      const claim = session.viewer.claim(ws, (reason) => {
        try {
          ws.send(JSON.stringify({ type: "error", error: reason }));
        } catch {
          // Best effort. The socket may already be gone, which is not a reason to stop tearing down.
        }
      });
      try {
        const send = (frame: unknown) => {
          // A closed socket starts a fresh cast on the next connection.
          try {
            ws.send(JSON.stringify(frame));
          } catch {
            void session.viewer.release(ws);
          }
        };

        /*
         * The cast follows the Bot's current page. Re-checking also handles a page being closed
         * underneath us without a listener per page.
         */
        let casting: Page | undefined;
        const attach = async () => {
          const target = await currentPage(ws.data.botId);
          if (target === casting) return;
          const cast = await startScreencast(target, send);
          // The claim stops a cast it refuses, so a launch that lost the screen leaks nothing.
          if (!(await claim.install(cast))) return;
          casting = target;
        };

        await attach();
        const follow = setInterval(() => {
          void attach().catch(() => undefined);
        }, FOLLOW_INTERVAL_MS);
        if (!claim.setFollow(() => clearInterval(follow))) return;
      } catch (error) {
        /*
         * Released before the socket is told, because this path is reachable in exactly the timing
         * the claim exists for. A claim left behind here would keep the session occupied for the life
         * of the process, and `forgetIdleSessions` could never sweep it: the unbounded growth that
         * function was written to stop, reintroduced by the error path of the fix for it.
         */
        await session.viewer.release(ws);
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
      if (ws.data.kind === "desktop") {
        const upstream = ws.data.upstream;
        if (!upstream || upstream.readyState !== WebSocket.OPEN) return;
        // A control socket is permission only while the lease is live. The view socket terminates
        // at a server-side read-only VNC instance, so even a modified client cannot inject through it.
        if (
          ws.data.mode === "control" &&
          !sessionFor(ws.data.botId).control.humanMayDrive(ws.data.lease)
        ) {
          upstream.close();
          ws.close(1008, TAKE_CONTROL_FIRST);
          return;
        }
        upstream.send(raw);
        return;
      }

      const session = sessionFor(ws.data.botId);
      /*
       * Whose screen this is, asked before anything is done with the input.
       *
       * A superseded socket used to dispatch through whatever the session held, so a replaced
       * window's typing landed in the page the current viewer was watching. It heard nothing about
       * it either, because the old missing-viewer check returned before reaching anything that could
       * report, which is why this answers the sender rather than returning quietly.
       *
       * Starting and gone are told apart deliberately. Both own no cast, and answering them the same
       * way tells somebody whose screen is still opening that their session ended.
       */
      const standing = session.viewer.standingOf(ws);
      if (standing.state !== "casting") {
        ws.send(
          JSON.stringify({
            type: "error",
            error:
              standing.state === "starting"
                ? SCREEN_STILL_STARTING
                : SCREEN_NO_LONGER_LIVE,
          }),
        );
        return;
      }
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
      // Owning the screen is not permission either, which is why this stands after the ownership
      // question above and not instead of it: the two refuse different things, and the one asked
      // first only decides whether the input has anywhere to land.
      //
      // Refuse with an error so the surface can explain why input is ignored.
      if (!session.control.humanMayDrive(ws.data.lease)) {
        ws.send(JSON.stringify({ type: "error", error: TAKE_CONTROL_FIRST }));
        return;
      }
      try {
        await standing.cast.send(message);
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
      if (ws.data.kind === "desktop") {
        ws.data.upstream?.close();
        return;
      }
      // Names the socket, so it can only ever give up its own screen. A superseded socket closing
      // after its replacement has started releases nothing; see viewer.ts.
      //
      // `get`, not `sessionFor`: a socket closing for a Bot with no session has nothing to release,
      // and creating one here would add a map entry on a teardown path, which is the direction the
      // map is meant to shrink in.
      await sessions.get(ws.data.botId)?.viewer.release(ws);
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

    // Refused here rather than deeper down, because the id names a directory and the API server
    // forwards whatever URL segment a caller typed. `reset` deletes that directory as root.
    // `/health` is exempt for the same reason it is exempt from the token: it names no Bot, and an
    // orchestrator's probe must not fail on a header it never meant to send.
    if (!isOpenPath(url.pathname) && !isPlainBotId(botId)) {
      return json({ error: "That is not a usable bot id." }, 400);
    }
    const session = sessionFor(botId);

    /*
     * The wheel, asked once for everything that acts.
     *
     * Refused here rather than inside each handler because the handler that forgets is the whole
     * defect: the shell shipped without this check and ran commands underneath a person who had taken
     * the browser at a login wall. `actsOnTheComputer` is the list, and a new acting endpoint is
     * refused by being added to it rather than by remembering to repeat this.
     */
    if (actsOnTheComputer(url.pathname)) {
      try {
        session.control.assertBotMayAct();
      } catch (error) {
        // A person holding the wheel is not a failure of the action; the Bot should wait and say so.
        if (error instanceof ControlError) {
          return json({ error: error.message, humanHasControl: true }, 409);
        }
        throw error;
      }
    }

    if (url.pathname === "/stream") {
      /*
       * The socket carries the Bot in the query because it cannot do it in a header. Every other call here names
       * its Bot in `x-openbot-bot-id`, but a websocket client sends no custom headers on the upgrade,
       * so the stream, and only the stream, also accepts the Bot as a query parameter. The header
       * still wins where there is one.
       */
      const streamBotId = botIdOf(request, url.searchParams.get("bot"));
      if (!isPlainBotId(streamBotId)) {
        return json({ error: "That is not a usable bot id." }, 400);
      }
      if (
        server.upgrade(request, {
          data: {
            kind: "page",
            botId: streamBotId,
            ...(url.searchParams.get("lease")
              ? { lease: url.searchParams.get("lease") as string }
              : {}),
          },
        })
      )
        return undefined as unknown as Response;
      return json({ error: "Expected a WebSocket upgrade." }, 400);
    }

    if (url.pathname === "/desktop") {
      const capability = desktopCapability();
      if (!capability.available) {
        return json(
          { error: "This computer does not provide a full desktop." },
          503,
        );
      }
      const desktopBotId = botIdOf(request, url.searchParams.get("bot"));
      if (!isPlainBotId(desktopBotId)) {
        return json({ error: "That is not a usable bot id." }, 400);
      }
      const mode = desktopMode(url.searchParams.get("mode"));
      const lease = url.searchParams.get("lease") ?? undefined;
      if (
        mode === "control" &&
        !sessionFor(desktopBotId).control.humanMayDrive(lease)
      ) {
        return json({ error: TAKE_CONTROL_FIRST }, 409);
      }
      const requestedProtocols =
        request.headers.get("sec-websocket-protocol") ?? "";
      if (
        server.upgrade(request, {
          data: { kind: "desktop", botId: desktopBotId, mode, lease },
          ...(requestedProtocols
            .split(",")
            .map((value) => value.trim())
            .includes("binary")
            ? { headers: { "sec-websocket-protocol": "binary" } }
            : {}),
        })
      ) {
        // A local dock click carries no HTTP Bot header. The control socket does, and it is the only
        // socket capable of delivering that click, so it selects the profile the dock reopens.
        if (mode === "control") {
          activeDesktopBotId = desktopBotId;
          activeDesktopLease = lease;
        }
        return undefined as unknown as Response;
      }
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

    if (url.pathname === "/capabilities" && request.method === "GET") {
      return json({ desktop: desktopCapability() });
    }

    // The browser icon inside the Linux desktop. It is authenticated like every other computer
    // route, and usable only while a person holds the wheel for the Bot selected by the control
    // socket above. `profiles.page` starts a missing browser or replaces a natively closed context;
    // `bringToFront` makes the same icon restore an existing browser instead of opening duplicates.
    if (url.pathname === "/desktop/apps/browser" && request.method === "POST") {
      const desktopBotId = activeDesktopBotId;
      if (!sessionFor(desktopBotId).control.humanMayDrive(activeDesktopLease)) {
        return json({ error: TAKE_CONTROL_FIRST }, 409);
      }
      try {
        const target = await currentPage(desktopBotId);
        await target.bringToFront();
        return json({
          opened: true,
          botId: desktopBotId,
          url: target.url(),
        });
      } catch (error) {
        return json(
          { error: describe(error, "The browser could not be opened.") },
          502,
        );
      }
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
        const target = await currentPage(botId);
        // Focus the field the Bot named, and let this throw if it cannot be found. A secret must not
        // be reported as delivered unless a field receives it.
        //
        // No generation check here: a Bot may take another snapshot after asking for a secret, while
        // the ref remains protected by Playwright's `aria-ref` rules.
        //
        // `aria-ref` resolves a ref only against the most recent snapshot, only while the element is
        // still connected, and mints a
        // new ref when an element's role or accessible name changes, so a recycled node cannot
        // inherit an old one. If the ref resolves, it is the field the Bot meant. If it does not,
        // nothing is typed, which is the outcome the generation check existed to guarantee.
        const field = locateRef(session, target, pending.ref, undefined);
        await field.click({ timeout: ACTION_TIMEOUT_MS });
        await field.fill(body.text, { timeout: ACTION_TIMEOUT_MS });
        const characters = body.text.length;
        // Cleared only after it actually landed, so a failure leaves the request open and the person
        // can try again rather than being told to start over.
        session.control.secretSupplied();
        return json({ supplied: true, characters, url: target.url() });
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
      const body = (await request.json().catch(() => null)) as {
        lease?: unknown;
        expiresAt?: unknown;
      } | null;
      try {
        return json(session.control.take(body?.lease, body?.expiresAt));
      } catch (error) {
        if (error instanceof ControlError) {
          return json({ error: error.message }, 409);
        }
        if (error instanceof ControlRequestError) {
          return json({ error: error.message }, 400);
        }
        throw error;
      }
    }

    if (url.pathname === "/control/renew" && request.method === "POST") {
      const body = (await request.json().catch(() => null)) as {
        lease?: unknown;
        expiresAt?: unknown;
      } | null;
      try {
        return json(session.control.renew(body?.lease, body?.expiresAt));
      } catch (error) {
        if (error instanceof ControlError) {
          return json({ error: error.message }, 409);
        }
        if (error instanceof ControlRequestError) {
          return json({ error: error.message }, 400);
        }
        throw error;
      }
    }

    if (url.pathname === "/control/release" && request.method === "POST") {
      // `reason` is dropped on release: it described the thing the person was asked to do, and once
      // they have done it, leaving it set would have the surface still showing the old request.
      const body = (await request.json().catch(() => null)) as {
        lease?: unknown;
      } | null;
      try {
        return json(session.control.release(body?.lease));
      } catch (error) {
        if (error instanceof ControlError) {
          return json({ error: error.message }, 409);
        }
        throw error;
      }
    }

    // A person's input, by pixel. The Bot addresses elements by reference because it reads a list; a
    // person addresses them by pointing, because they are looking at a picture. Different problem,
    // different endpoint, and only usable while they hold the wheel.
    if (HUMAN_INPUT.has(url.pathname) && request.method === "POST") {
      const body = (await request.json().catch(() => null)) as Record<
        string,
        unknown
      > | null;
      const lease = typeof body?.lease === "string" ? body.lease : undefined;
      if (!session.control.humanMayDrive(lease)) {
        return json({ error: TAKE_CONTROL_FIRST }, 409);
      }
      try {
        const target = await currentPage(botId);
        return json(await performHumanInput(target, url.pathname, body ?? {}));
      } catch (error) {
        return json({ error: describe(error, "That did not work.") }, 502);
      }
    }

    if (url.pathname === "/health") {
      const [profile] = profiles.summary([botId]);
      return json({
        status: "ok",
        // `browser` kept as it was: it is in the published contract and start.sh reads it.
        browser: profile?.running ?? false,
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
      return json({ computers: profiles.summary(await profiles.known()) });
    }

    /**
     * Stop the browser, keep what it knows.
     *
     * Closed gracefully so Chromium flushes its profile, and deliberately
     * not restarted here: the next request starts it again, which is the same path as a first ever
     * start, so there is no second way for a browser to come into existence.
     */
    if (url.pathname === "/computers/stop" && request.method === "POST") {
      const wasRunning = await profiles.stop(botId);
      // The wheel goes back to the Bot because the controlled browser no longer exists.
      session.control.revoke();
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
      await profiles.reset(botId);
      // Reset releases control because any previous browser session and pending secret request are gone.
      session.control.revoke();
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
        const target = await currentPage(botId);
        await target.goto(body.url, {
          waitUntil: "domcontentloaded",
          timeout: NAVIGATION_TIMEOUT_MS,
        });
        // A new document wipes every stamp, so every ref handed out before now is meaningless.
        // Bumping the generation makes an action carrying one fail with "take a new snapshot" rather
        // than fall through to a selector that matches nothing and read as a missing element.
        session.snapshotId += 1;
        const extract = await readablePageText(target);
        return json({
          url: target.url(),
          title: await target.title(),
          text: extract.text,
          truncated: extract.truncated,
          elapsedMs: Date.now() - startedAt,
        });
      } catch (error) {
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
        // A screenshot is observation, not an instruction to start an application. The transcript
        // polls this endpoint while somebody is watching; calling `currentPage` here relaunched
        // Chromium a second after the person closed its native window and made the VM look haunted.
        // The desktop and dock remain available, and the Browser launcher is the explicit start path.
        const target = profiles.runningPage(botId);
        if (!target) {
          return json(
            {
              error:
                "The browser is closed. Open it from the Browser icon on the computer desktop.",
            },
            409,
          );
        }
        const buffer = await target.screenshot({ type: "png" });
        const size = target.viewportSize() ?? { width: 1280, height: 800 };
        return json({
          base64: buffer.toString("base64"),
          width: size.width,
          height: size.height,
          capturedAt: new Date().toISOString(),
          // Which page this is a picture of. A browser that has not been sent anywhere sits on
          // `about:blank`, and a screenshot of that is a valid, entirely white PNG, indistinguishable
          // from a real page to anything looking only at the bytes. The transcript needs to tell
          // those apart to avoid presenting a blank browser as though it were a loaded page.
          url: target.url(),
        });
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
        const target = await currentPage(botId);
        const extract = await readablePageText(target);
        return json({
          url: target.url(),
          title: await target.title(),
          text: extract.text,
          truncated: extract.truncated,
        });
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
        return json(await snapshotPage(session, await currentPage(botId)));
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
        const target = await currentPage(botId);
        const detail = await performAction(
          session,
          target,
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
  target: Page,
  action: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const at = (): { x: number; y: number } => {
    const x = typeof body.x === "number" ? body.x : Number.NaN;
    const y = typeof body.y === "number" ? body.y : Number.NaN;
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error("A click needs an x and a y inside the page.");
    }
    // Clamped rather than rejected. A click a pixel outside the viewport is a rounding artefact of
    // scaling the screenshot, not a mistake worth refusing.
    return {
      x: Math.min(Math.max(x, 0), VIEWPORT.width - 1),
      y: Math.min(Math.max(y, 0), VIEWPORT.height - 1),
    };
  };

  if (action === "/human/click") {
    const { x, y } = at();
    await target.mouse.click(x, y);
    return { action: "human_click", url: target.url() };
  }

  if (action === "/human/type") {
    if (typeof body.text !== "string") {
      throw new Error("Typing needs text.");
    }
    // `insertText` rather than per-key typing: a person pasting a one-time code should not have it
    // arrive one character at a time into a field that reformats as you go.
    await target.keyboard.insertText(body.text);
    // Length only, never the value. See the note above about the model not being on this path.
    return {
      action: "human_type",
      characters: body.text.length,
      url: target.url(),
    };
  }

  if (action === "/human/key") {
    if (typeof body.key !== "string" || !body.key) {
      throw new Error("A key press needs a key name.");
    }
    await target.keyboard.press(body.key);
    return { action: "human_key", key: body.key, url: target.url() };
  }

  const deltaY = typeof body.deltaY === "number" ? body.deltaY : 400;
  await target.mouse.wheel(0, deltaY);
  return { action: "human_scroll", deltaY, url: target.url() };
}

/**
 * Carry out one action on the page.
 *
 * Every action that addresses an element goes through {@link locateRef}, so the staleness check
 * cannot be forgotten at a call site. `/key` and `/scroll` may omit a ref and act on the page itself,
 * which is how a Bot presses Enter to submit or scrolls to bring more of a long form into view.
 *
 * Stop has to reach the browser. `signal` is the caller's request going away, the person pressed
 * Stop, and the abort travels from the surface, through the server, to here. Without passing it on,
 * pressing Stop ended the run in the transcript while the click it was meant to prevent carried on
 * landing on a live page. Stop must reach the browser before a high-impact click lands.
 */
async function performAction(
  session: BotSession,
  target: Page,
  action: string,
  body: ActionBody,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  // Passed to every Playwright call below. It does not disable the timeout, which still applies.
  const acting = { timeout: ACTION_TIMEOUT_MS, ...(signal ? { signal } : {}) };
  const expected =
    typeof body.snapshotId === "number" ? body.snapshotId : undefined;
  const ref = typeof body.ref === "string" && body.ref ? body.ref : undefined;

  if (action === "/click") {
    if (!ref) throw new Error("A click needs the ref of an element to click.");
    await (await resolveRef(session, target, ref, expected)).click(acting);
    return { action: "click", ref, url: target.url() };
  }

  if (action === "/type") {
    if (!ref) throw new Error("Typing needs the ref of a field to type into.");
    if (typeof body.text !== "string") {
      throw new Error("Typing needs the text to enter.");
    }
    const field = await resolveRef(session, target, ref, expected);
    // `fill` rather than keystrokes: it clears the field first, which is what "put this value in
    // this box" means. Typing into a field a previous attempt half-filled otherwise appends, and the
    // form ends up with "AlicAlice" in it.
    await field.fill(body.text, acting);
    if (body.submit === true) {
      await field.press("Enter", acting);
    }
    // The text itself is deliberately NOT returned. It is echoed nowhere: this response is read by
    // the model and logged by the server, and a value typed into a form is exactly where a password
    // or a card number lives. The caller already knows what it sent.
    return {
      action: "type",
      ref,
      characters: body.text.length,
      submitted: body.submit === true,
      url: target.url(),
    };
  }

  if (action === "/key") {
    if (typeof body.key !== "string" || !body.key) {
      throw new Error("A key press needs a key name, such as Enter or Tab.");
    }
    if (ref) {
      await (await resolveRef(session, target, ref, expected)).press(
        body.key,
        acting,
      );
    } else {
      await target.keyboard.press(body.key);
    }
    return { action: "key", key: body.key, ref, url: target.url() };
  }

  // Scroll. A plain wheel event on the page, which is what moves a long form, rather than scrolling a
  // specific element into view: the Bot asked to see further down, not to hunt for one control.
  const deltaY = typeof body.deltaY === "number" ? body.deltaY : 600;
  await target.mouse.wheel(0, deltaY);
  return { action: "scroll", deltaY, url: target.url() };
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

console.info(`agent-computer listening on http://localhost:${PORT}`);

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
      await profiles.closeAll();
      process.exit(0);
    })();
  });
}
