import { downloadHeaders } from "@openbot/shared/file-download";
import { isPersonBrowserId } from "@openbot/shared/openbot-browser";
import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { BotAccessCheck } from "../agents/profile-policy";
import { ApprovalNeedsConversationError } from "../approvals/types";
import type { AuditReader } from "../audit";
import type { AppVariables } from "../auth/guards";
import { requireAdmin } from "../auth/guards";
import type { BotBrowser } from "../browser/bot-browser";
import { ownsPersonBrowser } from "../browser/person";
import { stampNarrationArrival } from "../browser/routes";
import {
  type ComputerSeat,
  parseComputerKey,
  personSeat,
  seatText,
} from "./computer-key";
import { DEPLOYMENT_ROUTES } from "./deployment-routes";
import {
  type ActionActor,
  ActionRefusedError,
  type ComputerGateway,
  ComputerStillStartingError,
  ComputerUnavailableError,
  ElementNotFoundError,
  HandoffRequestError,
  HumanHasControlError,
  NavigationRefusedError,
  StaleSnapshotError,
  WorkspaceNotFoundError,
  WorkspaceRefusedError,
  WorkspaceRequestError,
  WorkspaceTooLargeError,
} from "./gateway";
import type { PageFrameStore } from "./page-frames";
import { dryRunAgainstHistory, REPLAYABLE_EVENT_TYPES } from "./policy-dry-run";
import { type PolicyStore, parseActionPolicy } from "./policy-store";

/**
 * The Bot computer's surface, behind the same session guard as every other API route.
 *
 * The computer has token authentication but no user/session identity. These server routes require a
 * session guard because `COMPUTER_TOKEN` proves the caller is an internal service, not which user is
 * asking to drive the browser.
 *
 * Every computer call goes through the gateway. That is the governance seam: each acting route in
 * this file passes through a policy decision and audit row before it reaches the computer.
 */

/** What a person's own browser answers under this router: the reads its live screen makes. */
const PERSON_BROWSER_READS = new Set(["control", "status", "screenshot"]);

export function createComputerRoutes(
  gateway: ComputerGateway,
  policyStore: PolicyStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  /**
   * Whether the caller may act as the Bot in the path. Required rather than optional, so a new
   * deployment cannot be wired up without an answer to it.
   */
  canUseBot: BotAccessCheck,
  /** Where the frame a page was opened on is kept. Absent leaves the transcript as it was. */
  pageFrames?: PageFrameStore,
  /**
   * For the policy dry-run, which replays the trail. Optional the way `auditReader` is optional in
   * `createApp`: a deployment wired without one still governs and records actions, and the dry-run
   * endpoint says it cannot answer rather than answering from nothing.
   */
  auditReader?: AuditReader,
  /**
   * The bar above a Bot's screen and Record, for the person holding its wheel (browser/bot-browser.ts), at
   * `/:botId/browser`. Absent where this OpenBot has no Recorder: nothing about it is mounted.
   */
  botBrowser?: BotBrowser,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  // A phrase's arrival, noted before the guard below signs the person in and asks about the Bot, which can take any
  // time: the narration's times are moved onto this server's clock from it (browser/routes.ts).
  if (botBrowser)
    routes.use("/:botId/browser/narration", stampNarrationArrival);

  /**
   * Every route under a Bot id, in one place.
   *
   * The Bot travels in the path, so each route would otherwise have to remember to ask, and the one
   * that forgot would be the whole surface. Reads are gated as well as actions: a screenshot of
   * somebody's Bot is whatever page it is signed into.
   *
   * The answer is the same for a Bot that does not exist and one belonging to somebody else, so this
   * cannot be used to find out which Bots a deployment has.
   */
  routes.use("/:botId/*", requireUser, async (context, next) => {
    const botId = context.req.param("botId");
    /*
     * `/policy` and `/fleet` are this router's own, and they are not about a Bot.
     *
     * Hono matches `/*` against zero segments, so `/policy` arrives here as a Bot called "policy",
     * `canUseBot` quite correctly says there is no such Bot, and the Boundaries screen answers 404
     * for everybody including an administrator. Named rather than inferred from the segment count,
     * because a second deployment-wide route added later should have to think about this line.
     *
     * The name alone is not enough to step aside on, though. Both deployment routes are a single
     * segment, so `/policy/status` is `/:botId/status` and nothing more: skipping the whole subtree
     * would hand the computer of a Bot called `policy` to anybody who can sign in, with the guard
     * never asked rather than merely bypassed. Bot ids are reserved against these names where a Bot
     * is created, so such a Bot should not exist; this is the half that holds if one ever does.
     */
    const path = context.req.path.replace(/\/+$/, "");
    if (botId && DEPLOYMENT_ROUTES.has(botId) && path.endsWith(`/${botId}`)) {
      return next();
    }

    /*
     * A person's own OpenBot browser, named for the person (browser/person.ts), answers here only what its live screen
     * reads, and only to that person: who holds the wheel, whether it is up, and a picture of the page. Asked here and
     * not of `canUseBot`, which a deployment with no profile store answers yes to for everybody. Nothing that acts as a
     * Bot (a click through the boundary, a command, a file) reaches a person's browser: no Bot uses one yet.
     */
    if (botId && isPersonBrowserId(botId)) {
      const route = path.slice(
        path.lastIndexOf(`/${botId}/`) + botId.length + 2,
      );
      return context.req.method === "GET" &&
        PERSON_BROWSER_READS.has(route) &&
        ownsPersonBrowser(context.var.actor, botId)
        ? next()
        : context.json({ error: "There is no such Bot." }, 404);
    }

    if (botId && !(await canUseBot(context.var.actor, botId))) {
      return context.json({ error: "There is no such Bot." }, 404);
    }
    await next();
  });

  /**
   * The seat this request is for: the Bot in the path, for the person asking.
   *
   * Every route under a Bot reaches that Bot on the asker's computer (or on the Bot's own, for an
   * isolated Bot), never on whoever used it last. See computer-key.ts.
   */
  const seatOf = (context: ComputerContext): Promise<ComputerSeat> =>
    gateway.seatFor(
      context.req.param("botId") ?? "default",
      context.var.actor.id,
    );

  // After the guard, so everything under it has passed it: a person's own browser id never gets here.
  if (botBrowser) routes.route("/:botId/browser", botBrowser.routes);

  routes.get("/:botId/status", async (context) => {
    return context.json(await gateway.status(await seatOf(context)));
  });

  /**
   * The frame a watcher polls for, and never the thing that wakes a computer.
   *
   * `screenshot` goes through `locate`, and `locate` resumes a suspended computer and waits for it.
   * Called blind, opening the panel was enough to start a Bot's computer, every poll after that held
   * a request open for the length of a cold start, and the first one to give up was drawn as "can't
   * show the screen". The computer starts on the first thing a Bot does with it; looking at it is
   * not that.
   *
   * So the status is asked first, which reads the provider's own record and touches nothing. A
   * computer that is not ready answers 200 with `ready: false` and its state: an answer, not an
   * error, because a computer that is asleep or starting is behaving normally and the panel draws
   * it as such. Only an unreachable one is a fault, and the state says that too.
   *
   * There is a gap between the two calls, and a computer suspended inside it is woken by the
   * screenshot. The culler suspends after a long idle, so landing in that gap needs a viewer polling
   * at the exact moment of the suspend; the cost is one computer started early, never a wrong frame.
   */
  routes.get("/:botId/screenshot", async (context) => {
    try {
      const seat = await seatOf(context);
      const status = await gateway.status(seat);
      if (status.state !== "ready") {
        return context.json({
          ready: false,
          state: status.state,
          ...(status.reason ? { reason: status.reason } : {}),
        });
      }
      return context.json(await gateway.screenshot(seat));
    } catch (error) {
      return context.json(errorBody(error), statusFor(error));
    }
  });

  routes.get("/:botId/read", async (context) => {
    try {
      return context.json(await gateway.read(await seatOf(context)));
    } catch (error) {
      return context.json(errorBody(error), statusFor(error));
    }
  });

  /**
   * Whether the same page is on both, ignoring the two ways one page spells itself.
   *
   * The trailing slash a browser adds and the fragment it keeps are not different pages. A URL that
   * cannot be parsed is compared as written.
   */
  function samePage(a: string, b: string): boolean {
    const tidy = (value: string) => {
      try {
        const parsed = new URL(value);
        parsed.hash = "";
        return parsed.toString().replace(/\/$/, "");
      } catch {
        return value.replace(/\/$/, "");
      }
    };
    return tidy(a) === tidy(b);
  }

  /**
   * Whether a screenshot can be trusted to be of the page this turn opened.
   *
   * A SCREENSHOT THAT DOES NOT SAY WHAT IT IS OF IS THE ORDINARY CASE ON AN OLD COMPUTER. The url on
   * a screenshot was added after the first computers shipped, so an `agent-computer` that has not
   * been redeployed sends none. Refusing on a missing url therefore did not fail safe, it failed
   * silently and completely: on a fleet part-way through a rollout the feature kept no frames at all
   * and said nothing about why.
   *
   * So the question is asked where it means something. With a computer each there is no second Bot
   * to race with, nothing can have moved the page between the navigation and the picture, and an
   * unknown page is this turn's page. On one shared computer another Bot's navigation lands in
   * exactly that gap, which is the case this guard exists for, and there an unknown page is refused.
   */
  function frameIsOfThisPage(
    shotUrl: string | undefined,
    pageUrl: string,
  ): { ok: true } | { ok: false; why: string } {
    if (shotUrl === undefined) {
      if (gateway.provider.isolation === "per-person") return { ok: true };
      return {
        ok: false,
        why: "this computer is shared and the screenshot did not say which page it is of, so it cannot be told apart from another Bot's",
      };
    }
    if (!samePage(shotUrl, pageUrl)) {
      return { ok: false, why: `the screen showed ${shotUrl}` };
    }
    return { ok: true };
  }

  /**
   * Photograph the page this turn just opened.
   *
   * Awaited rather than left running, so a surface asking for the frame the moment the turn ends
   * finds it there. A navigation already costs seconds; one screenshot inside the cluster does not
   * change how the tool feels, and a frame that arrives after the reader has gone is no frame at all.
   *
   * CHECKED AGAINST THE PAGE THE NAVIGATION REPORTED, because the screenshot is a second round trip
   * and nothing holds the browser still between them. With one computer shared by every Bot, another
   * Bot's navigation lands in that gap and this would file its page under this turn. The guard used
   * to live in the browser and was deleted when the capture moved here; it belongs on whichever side
   * does the capturing.
   *
   * Never fatal. A stored picture is a convenience for reading a conversation back, and failing the
   * navigation the Bot was asked to do because the convenience failed would be the wrong trade every
   * time. EVERY REFUSAL SAYS SO, including the two that used to return quietly: a deployment that
   * keeps no frames has to be able to find out why from its own logs rather than by reading this file.
   */
  async function keepFrameOf(
    seat: ComputerSeat,
    toolCallId: string,
    url: string,
    title: string,
  ) {
    if (!pageFrames) return;
    if (!toolCallId) {
      console.warn(
        `[computer] not keeping a frame of ${url}: the caller did not say which turn it was for.`,
      );
      return;
    }
    try {
      /*
       * Only if the computer is already up. `screenshot` goes through `locate`, which resumes a
       * suspended computer, so a convenience picture could wake a machine the culler had just put to
       * sleep and hold a navigation open for the length of a pod schedule while it did.
       */
      const status = await gateway.status(seat);
      if (status.state !== "ready") {
        console.warn(
          `[computer] not keeping a frame for ${toolCallId}: the computer is ${status.state}, and photographing it would wake it.`,
        );
        return;
      }
      const shot = await gateway.screenshot(seat);
      const verdict = frameIsOfThisPage(shot.url, url);
      if (!verdict.ok) {
        console.warn(
          `[computer] not keeping a frame for ${toolCallId}: ${verdict.why} rather than ${url}.`,
        );
        return;
      }
      await pageFrames.save({
        // Filed under the seat, so one person's pictures are never another's on the same Bot.
        computerId: seatText(seat),
        toolCallId,
        url,
        title,
        frame: shot.base64,
      });
    } catch (error) {
      console.warn(
        `[computer] could not keep a frame of ${url}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  routes.post("/:botId/navigate", async (context) => {
    const body = (await context.req.json().catch(() => null)) as {
      url?: unknown;
      toolCallId?: unknown;
    } | null;
    if (typeof body?.url !== "string" || !body.url.trim()) {
      return context.json({ error: "A web address is required." }, 400);
    }
    /*
     * Which turn asked, so the picture can be filed under it. Optional: a caller that does not know
     * (the side panel, a script) still navigates, and simply keeps no frame.
     */
    const toolCallId =
      typeof body.toolCallId === "string" ? body.toolCallId : "";

    try {
      const seat = await seatOf(context);
      const result = await gateway.navigate(
        seat,
        {
          id: context.var.actor.id,
          ...(context.var.actor.email === DEV_ACTOR_EMAIL
            ? {}
            : { userId: context.var.actor.id }),
        },
        body.url.trim(),
        toolCallId || undefined,
      );
      await keepFrameOf(seat, toolCallId, result.url, result.title);
      return context.json(result);
    } catch (error) {
      if (error instanceof ActionRefusedError) {
        return context.json({ error: error.message, rule: error.rule }, 403);
      }
      // A refusal is the rules working, not a fault, so it is a 403 with the reason a person reads.
      // Collapsing it into the same 5xx as an unreachable computer would send somebody looking for
      // an outage that is not happening.
      if (error instanceof NavigationRefusedError) {
        return context.json({ error: error.message }, 403);
      }
      return context.json(errorBody(error), statusFor(error));
    }
  });

  routes.post("/:botId/snapshot", async (context) => {
    try {
      return context.json(await gateway.snapshot(await seatOf(context)));
    } catch (error) {
      return context.json(errorBody(error), statusFor(error));
    }
  });

  /**
   * The acting routes.
   *
   * Each one hands the gateway the Bot, the actor and the input, and does no checking
   * of its own beyond the shape of the request. Where a decision gets made is a single place.
   */
  routes.post("/:botId/click", (context) =>
    act(context, gateway.seatFor, (seat, actor, body, signal) => {
      const ref = asRef(body);
      if (!ref) return badRef;
      return gateway.click(seat, actor, ref, signal);
    }),
  );

  routes.post("/:botId/type", (context) =>
    act(context, gateway.seatFor, (seat, actor, body, signal) => {
      const ref = asRef(body);
      if (!ref) return badRef;
      if (typeof body?.text !== "string") {
        return { error: "The text to enter is required." };
      }
      return gateway.type(
        seat,
        actor,
        {
          ...ref,
          text: body.text,
          submit: body?.submit === true,
        },
        signal,
      );
    }),
  );

  routes.post("/:botId/key", (context) =>
    act(context, gateway.seatFor, (seat, actor, body, signal) => {
      if (typeof body?.key !== "string" || !body.key) {
        return { error: "A key name is required, such as Enter or Tab." };
      }
      const ref = asRef(body);
      return gateway.key(
        seat,
        actor,
        {
          key: body.key,
          ...(ref ?? {}),
        },
        signal,
      );
    }),
  );

  routes.post("/:botId/scroll", (context) =>
    act(context, gateway.seatFor, (seat, actor, body) => {
      if (!usableDeltaY(body?.deltaY)) return badDeltaY;
      return gateway.scroll(seat, actor, {
        ...(typeof body?.deltaY === "number" ? { deltaY: body.deltaY } : {}),
      });
    }),
  );

  /**
   * Who has the wheel. Polled by the surface next to the screen, so the person sees the Bot ask for
   * help without reloading anything.
   */
  routes.get("/:botId/control", async (context) => {
    try {
      return context.json(
        await gateway.control(
          await seatOf(context),
          context.req.query("requestId"),
        ),
      );
    } catch (error) {
      return context.json(errorBody(error), statusFor(error));
    }
  });

  routes.post("/:botId/control/request", (context) =>
    act(context, gateway.seatFor, (seat, actor, body) =>
      gateway.requestHelp(
        seat,
        actor,
        typeof body?.reason === "string" && body.reason.trim()
          ? body.reason.trim()
          : "It can't continue without you.",
        typeof body?.toolCallId === "string" ? body.toolCallId : undefined,
        // A person taking the wheel themselves says so; anything else is the Bot asking, as it always was.
        body?.source === "manual" ? "manual" : "model",
      ),
    ),
  );

  /**
   * The computers, for the admin surface.
   *
   * Not per-Bot in the path the way the acting routes are: this asks the computer what it holds, and
   * it holds a list. `:botId` is still there because every route under this router has it. The
   * list itself is every computer, so a signed-in user is not enough; an administrator has to ask.
   */
  /**
   * Every computer in the deployment.
   *
   * Its own route rather than `/:botId/computers`, which is what Admin used to call with a
   * placeholder id. That worked until the bot-access middleware arrived: the placeholder is not a
   * Bot, `canUseBot` said so, and the screen 404d for everybody including an administrator, showing
   * an empty page rather than the fleet. The list is deployment-wide, so it is addressed
   * deployment-wide and named in DEPLOYMENT_ROUTES beside `/policy`.
   */
  routes.get("/fleet", requireUser, async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;

    try {
      return context.json(await gateway.computers());
    } catch (error) {
      return context.json(errorBody(error), statusFor(error));
    }
  });

  /**
   * An administrator acting on one computer from the list: stop, reset or update.
   *
   * Addressed by whose computer it is (`person:<id>` or `bot:<id>`), not by a Bot in the path,
   * because the computer on the list is somebody else's: the Bot routes below act on the asker's own
   * seat. `botId` names one seat on the shared computer, which lists seats rather than computers.
   * A single segment, like `GET /fleet`, so the Bot guard above steps aside for it by name.
   */
  routes.post("/fleet", requireUser, async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    const body = (await context.req.json().catch(() => null)) as {
      action?: unknown;
      computer?: unknown;
      botId?: unknown;
    } | null;
    const key = parseComputerKey(body?.computer);
    if (!key) {
      return context.json(
        { error: "Say which computer: person:<id> or bot:<id>." },
        400,
      );
    }
    if (
      body?.botId !== undefined &&
      (typeof body.botId !== "string" ||
        !body.botId.trim() ||
        body.botId.length > 200)
    ) {
      return context.json({ error: "botId names one Bot." }, 400);
    }
    const target = {
      key,
      ...(typeof body?.botId === "string" ? { botId: body.botId } : {}),
    };
    const actor = actorOf(context.var.actor);
    try {
      switch (body?.action) {
        case "stop":
          return context.json(await gateway.stopTarget(target, actor));
        case "reset":
          return context.json(await gateway.resetTarget(target, actor));
        case "update":
          return context.json(await gateway.updateTarget(key, actor));
        default:
          return context.json(
            { error: "The action is stop, reset or update." },
            400,
          );
      }
    } catch (error) {
      return actionFailure(context, error);
    }
  });

  routes.get("/:botId/computers", async (context) => {
    // The session guard and the question of whether this person may act as the Bot in the path are
    // both applied by the middleware above. Neither is the question here: the answer is the whole
    // fleet whatever `:botId` says, so it takes administering the deployment.
    const denied = requireAdmin(context);
    if (denied) return denied;

    try {
      return context.json(await gateway.computers());
    } catch (error) {
      return context.json(errorBody(error), statusFor(error));
    }
  });

  /** Stop the browser, keep the logins. */
  routes.post("/:botId/computers/stop", (context) =>
    act(context, gateway.seatFor, (seat, actor) =>
      gateway.stopComputer(seat, actor),
    ),
  );

  /** Delete the profile. Every login goes with it, which is the point and also the danger. */
  routes.post("/:botId/computers/reset", (context) =>
    act(context, gateway.seatFor, (seat, actor) =>
      gateway.resetComputer(seat, actor),
    ),
  );

  /**
   * Move the computer onto the image this deployment now runs. Files and sign-ins stay; a running
   * computer restarts, so this is a person's button and never something a wake does to a busy one.
   */
  routes.post("/:botId/computers/update", (context) =>
    act(context, gateway.seatFor, (seat, actor) =>
      gateway.updateComputer(seat, actor),
    ),
  );

  routes.post("/:botId/control/take", (context) =>
    act(context, gateway.seatFor, (seat, actor, body) =>
      gateway.takeControl(seat, actor, handoffId(body)),
    ),
  );

  /*
   * Handing the wheel back, or the Bot's request being cancelled, ends any recording in the Bot's browser (the computer
   * ends it), and every Recorder connection the browser holds goes with it: the Bot's network stops letting the Recorder
   * out (browser/bot-browser.ts). A Bot whose wheel a person held acts again only once it is handed back here.
   */
  routes.post("/:botId/control/release", (context) =>
    act(context, gateway.seatFor, async (seat, actor, body) => {
      let state: Awaited<ReturnType<typeof gateway.releaseControl>>;
      try {
        state = await gateway.releaseControl(seat, actor, handoffId(body));
      } catch (error) {
        // The computer may have handed it back though its answer never came (a timeout): what it says now decides.
        await botBrowser?.wheelMayHaveReturned(seat);
        throw error;
      }
      await botBrowser?.wheelReturned(seat);
      return state;
    }),
  );

  routes.post("/:botId/control/cancel", (context) =>
    act(context, gateway.seatFor, async (seat, actor, body) => {
      let state: Awaited<ReturnType<typeof gateway.cancelControl>>;
      try {
        state = await gateway.cancelControl(seat, actor, handoffId(body));
      } catch (error) {
        await botBrowser?.wheelMayHaveReturned(seat);
        throw error;
      }
      await botBrowser?.wheelReturned(seat);
      return state;
    }),
  );

  /** The Bot asking for a value it must not be told. */
  routes.post("/:botId/control/secret", (context) =>
    act(context, gateway.seatFor, (seat, actor, body) => {
      if (typeof body?.ref !== "string" || !body.ref) {
        return {
          error:
            "Say which field the value goes in, using a ref from your snapshot.",
        };
      }
      if (
        typeof body?.snapshotId !== "number" ||
        !Number.isInteger(body.snapshotId)
      ) {
        return { error: "The snapshotId the ref came from is required." };
      }
      return gateway.requestSecret(seat, actor, {
        label:
          typeof body?.label === "string" && body.label.trim()
            ? body.label.trim()
            : "the value this page is asking for",
        ref: body.ref,
        snapshotId: body.snapshotId,
      });
    }),
  );

  /**
   * A person supplying it.
   *
   * The value is read from the body, passed straight through, and referred to nowhere else. Its own
   * route rather than a `kind` on the input route below, so that grepping for where a secret can enter
   * this server returns exactly one place.
   */
  routes.post("/:botId/human/secret", (context) =>
    act(context, gateway.seatFor, (seat, actor, body) => {
      if (typeof body?.text !== "string" || !body.text) {
        return { error: "A value is required." };
      }
      return gateway.supplySecret(seat, actor, body.text);
    }),
  );

  /**
   * A person's own mouse and keyboard.
   *
   * Not through the policy decision, and not audited per keystroke. See `ComputerGateway.humanInput`.
   * The takeover is the audited event; what the person typed during it is deliberately unrecorded,
   * because the reason a takeover exists is to let them enter the thing nothing else should keep.
   */
  routes.post("/:botId/human/:kind", async (context) => {
    const kind = context.req.param("kind");
    if (
      kind !== "click" &&
      kind !== "type" &&
      kind !== "key" &&
      kind !== "scroll"
    ) {
      return context.json({ error: "Unknown input." }, 400);
    }
    const body = (await context.req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    /*
     * Shaped per gesture, like the Bot's acting routes shape theirs. Only scroll was checked:
     * a click with `{"x": "ten"}`, a type with `{"text": 123}` or a key with `{}` travelled
     * to the computer untouched, and the failure surfaced as whatever the computer returned
     * for garbage — mapped here to a 500, or a 200 no-op. The shapes below are the ones the
     * gateway's `HumanInput` type already promises the computer: coordinates in viewport
     * pixels, text to enter, a key name. Scroll keeps its existing check, which allows an
     * absent delta the computer reads as its own default distance.
     */
    if (kind === "click") {
      if (
        typeof body?.x !== "number" ||
        !Number.isFinite(body.x) ||
        typeof body?.y !== "number" ||
        !Number.isFinite(body.y)
      ) {
        return context.json(
          { error: "A click needs numeric x and y coordinates." },
          400,
        );
      }
    }
    if (kind === "type") {
      if (typeof body?.text !== "string") {
        return context.json({ error: "The text to enter is required." }, 400);
      }
    }
    if (kind === "key") {
      if (typeof body?.key !== "string" || !body.key) {
        return context.json(
          { error: "A key name is required, such as Enter or Tab." },
          400,
        );
      }
    }
    if (kind === "scroll" && !usableDeltaY(body?.deltaY)) {
      return context.json(badDeltaY, 400);
    }
    try {
      return context.json(
        await gateway.humanInput(await seatOf(context), {
          ...(body ?? {}),
          // Last, so the checked value wins. Spread over it, a body carrying its own `kind` replaced
          // the one this route had just checked, and the gateway puts that value into the path it
          // calls on the computer.
          kind,
        } as Parameters<typeof gateway.humanInput>[1]),
      );
    } catch (error) {
      return context.json(errorBody(error), statusFor(error));
    }
  });

  /** The Bot's files. Through the gateway, like every other acting call. */
  /**
   * The frame this turn was showing when it opened its page.
   *
   * Read only. Nothing writes through a route: the frame is taken where the navigation happens,
   * which is the one moment the screen is certainly showing the page that was asked for. The surface
   * used to capture it itself, after the turn, and lost the race often enough to show the wrong page
   * or a blank one.
   */
  routes.get("/:botId/page-frame/:toolCallId", async (context) => {
    if (!pageFrames) return context.json({ frame: null });
    // Unvalidated params reach the frame table as-is. Blank or overlong ids can never name a
    // stored frame, so they are refused here instead of becoming junk reads.
    const botId = context.req.param("botId");
    const toolCallId = context.req.param("toolCallId");
    if (!botId.trim() || !toolCallId.trim()) {
      return context.json({ error: "A Bot and a turn are required." }, 400);
    }
    if (botId.length > 200 || toolCallId.length > 200) {
      return context.json({ error: "A Bot and a turn are required." }, 400);
    }
    /*
     * The asker's own seat first, and then the two places a frame of theirs can have been filed
     * before it: their seat on their own computer, when the Bot has since become isolated, and the
     * Bot alone, which is where every frame went before computers were per person. Never another
     * person's seat, so naming a turn cannot read somebody else's screen.
     */
    const seat = await seatOf(context);
    const candidates = [
      ...new Set([
        seatText(seat),
        seatText(personSeat(context.var.actor.id, botId)),
        botId,
      ]),
    ];
    for (const computerId of candidates) {
      const stored = await pageFrames.load(computerId, toolCallId);
      if (stored) return context.json({ frame: stored });
    }
    return context.json({ frame: null });
  });

  routes.post("/:botId/files/list", (context) =>
    act(context, gateway.seatFor, (seat, actor, body) =>
      gateway.listFiles(seat, actor, {
        ...(typeof body?.path === "string" && body.path.trim()
          ? { path: body.path.trim() }
          : {}),
      }),
    ),
  );

  routes.post("/:botId/files/read", (context) =>
    act(context, gateway.seatFor, (seat, actor, body) => {
      if (typeof body?.path !== "string" || !body.path.trim()) {
        return { error: "A file path is required." };
      }
      return gateway.readFile(seat, actor, { path: body.path.trim() });
    }),
  );

  /**
   * A person downloading a file the Bot generated.
   *
   * This is a GET because a browser download is a navigation, not a JSON action. It still goes
   * through the gateway, so the separate `computer_download_file` intent is decided and audited
   * before the computer is asked for bytes. Ownership is enforced by the `/:botId/*` middleware
   * above, and the response is always an opaque attachment so HTML cannot render on this origin.
   */
  routes.get("/:botId/files/download", async (context) => {
    const path = context.req.query("path");
    if (!path?.trim()) {
      return context.json({ error: "A file path is required." }, 400);
    }

    try {
      const file = await gateway.downloadFile(
        await seatOf(context),
        actorOf(context.var.actor),
        { path: path.trim() },
        context.req.raw.signal,
      );
      return new Response(file.body, {
        headers: downloadHeaders(file.name, file.bytes),
      });
    } catch (error) {
      return actionFailure(context, error);
    }
  });

  /*
   * A command on the Bot's computer.
   *
   * Same shape as every other acting route: the gateway decides and records, this only shapes the
   * request. `timeoutMs` is validated here against the shell's own bounds (1s floor, 600s ceiling),
   * so a NaN, an Infinity, a negative, or a ten-hour value answers 400 instead of travelling to the
   * computer as a RangeError 500 or a run that outlasts the transport backstop.
   */
  routes.post("/:botId/exec", (context) =>
    act(context, gateway.seatFor, (seat, actor, body, signal) => {
      if (typeof body?.command !== "string" || !body.command.trim()) {
        return { error: "A command is required." };
      }
      if (body.timeoutMs !== undefined) {
        if (
          typeof body.timeoutMs !== "number" ||
          !Number.isInteger(body.timeoutMs) ||
          body.timeoutMs < 1_000 ||
          body.timeoutMs > 600_000
        ) {
          return {
            error:
              "timeoutMs must be a whole number of milliseconds between 1000 and 600000.",
          };
        }
      }
      // The fourth argument, like every other acting route. Without it the plumbing through
      // gateway.runCommand and into the shell's own abort listener was dead code, and Stop ended the
      // run in the transcript while the command carried on to completion inside the container.
      return gateway.runCommand(
        seat,
        actor,
        {
          command: body.command,
          ...(typeof body.timeoutMs === "number"
            ? { timeoutMs: body.timeoutMs }
            : {}),
        },
        signal,
      );
    }),
  );

  routes.post("/:botId/files/write", (context) =>
    act(context, gateway.seatFor, (seat, actor, body) => {
      if (typeof body?.path !== "string" || !body.path.trim()) {
        return { error: "A file path is required." };
      }
      if (typeof body?.contents !== "string") {
        return { error: "The contents to write are required." };
      }
      return gateway.writeFile(seat, actor, {
        path: body.path.trim(),
        contents: body.contents,
        append: body.append === true,
      });
    }),
  );

  /**
   * The policy, readable and writable by an administrator.
   *
   * Here rather than in the admin routes file, because this directory owns the computer and `app.ts`
   * takes one appended line per mount. The storage underneath is durable, so administrator rules
   * remain active after a restart.
   */
  routes.get("/policy", requireUser, (context) => {
    const denied = requireAdmin(context);
    return denied ?? context.json({ policy: policyStore.get() });
  });

  routes.put("/policy", requireUser, async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;

    const parsed = parseActionPolicy(
      await context.req.json().catch(() => null),
    );
    if (!parsed.ok) {
      return context.json({ error: parsed.error }, 400);
    }
    try {
      await policyStore.set(parsed.policy, context.var.actor.email);
    } catch {
      /*
       * Saved, or said so. A boundary that is enforced now and gone after the next restart is worse
       * than one that was never set, so a policy that could not be written is reported as a failure
       * rather than quietly held in memory. Nothing changes: the previous policy is still in force.
       */
      return context.json(
        {
          error:
            "Couldn't save that rule. The previous boundary still applies.",
        },
        503,
      );
    }
    // Echoed back so a caller can see exactly what is now in force rather than assuming its request
    // was stored verbatim.
    return context.json({ policy: policyStore.get() });
  });

  /**
   * What would this policy have decided, about actions already on the trail?
   *
   * A rule is otherwise written blind: saved first, understood later, from the refusals it produces
   * in production. This answers before the save — the candidate is validated exactly as PUT
   * validates it, replayed over recent judged actions, and the reply names each action it would have
   * decided differently and the rule that would have decided it.
   *
   * A POST that writes nothing: not the policy, and no audit row either. Nothing is decided here —
   * no action is permitted or refused, nothing runs or is stopped — and a trail row for every
   * what-if would bury the rows that record what actually happened. Deployment-wide and named in
   * DEPLOYMENT_ROUTES beside `/policy`, and admin-gated the same way, because history is the
   * administrator's view.
   */
  routes.post("/policy-dry-run", requireUser, async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;

    if (!auditReader) {
      return context.json(
        {
          error:
            "This deployment records no readable trail, so there is no history to test against.",
        },
        501,
      );
    }

    const body = (await context.req.json().catch(() => null)) as {
      policy?: unknown;
      limit?: unknown;
    } | null;
    const parsed = parseActionPolicy(body?.policy);
    if (!parsed.ok) {
      return context.json({ error: parsed.error }, 400);
    }

    // Bounded, and biased to recency: the question is what this rule does to the traffic the
    // deployment actually has, and last week's traffic answers that better than a full scan.
    //
    // Strict on purpose. This used to read `typeof limit === "number" ? limit : 200` and clamp,
    // so `"abc"`, `null` and `true` silently became 200, `Infinity` silently became 500, and
    // `NaN` became `NaN` and travelled into `auditReader.list` as one. A what-if answered from
    // the wrong slice of history is worse than no answer, because it is believed.
    const rawLimit = body?.limit;
    let limit = 200;
    if (rawLimit !== undefined) {
      if (
        typeof rawLimit !== "number" ||
        !Number.isInteger(rawLimit) ||
        rawLimit < 1 ||
        rawLimit > 500
      ) {
        return context.json(
          { error: "limit must be a whole number between 1 and 500." },
          400,
        );
      }
      limit = rawLimit;
    }

    const { events } = await auditReader.list({
      limit,
      eventType: REPLAYABLE_EVENT_TYPES.join(","),
      targetType: "computer",
    });

    return context.json({
      report: dryRunAgainstHistory(parsed.policy, events),
    });
  });

  return routes;
}

type ComputerContext = Context<{ Variables: AppVariables }>;

/** A request that was rejected before any decision was needed, because it was not a valid action. */
type BadRequest = { error: string };

const badRef: BadRequest = {
  error:
    "A ref and the snapshotId it came from are both required. Take a snapshot first.",
};

const badDeltaY: BadRequest = {
  error: "deltaY must be a finite number of pixels.",
};

/**
 * Whether a wheel delta from an untrusted body can be carried out.
 *
 * `typeof value === "number"` is true of `Infinity`, and JSON carries it: `1e999` parses to it. It
 * then survives every comparison on the way down and is erased by `JSON.stringify` on the hop to the
 * computer, which reads the missing field as absent and scrolls its own default distance instead --
 * so the caller is answered 200 for a scroll nobody asked for. Every other number on this surface is
 * already checked at the edge: the timeout on `exec`, the coordinates behind `human/click`. This one
 * was not.
 */
function usableDeltaY(value: unknown): boolean {
  return value === undefined || Number.isFinite(value);
}

/**
 * Shared plumbing for acting routes that use this helper: resolve who is asking, run, and map
 * failures onto statuses.
 *
 * One place, so a new acting route cannot accidentally report a policy refusal as a server error, and
 * so the actor is derived the same way every time.
 */
async function act(
  context: ComputerContext,
  /** Whose computer the Bot runs on for the asker. See `ComputerGateway.seatFor`. */
  seatFor: (botId: string, personId: string) => Promise<ComputerSeat>,
  handler: (
    /** The Bot in the path, on the asker's computer. */
    seat: ComputerSeat,
    actor: ActionActor,
    body: Record<string, unknown> | null,
    /**
     * The person's Stop, as an abort.
     *
     * The surface aborts its request when Stop is pressed; Bun exposes that here, and every acting
     * route passes it on so the abort reaches the Playwright call mid-click. Without it, Stop ended
     * the run in the transcript while the click carried on landing on a live page, harmless most of
     * the time, and not harmless on a Confirm button, which is exactly when Stop gets pressed.
     */
    signal: AbortSignal,
  ) => Promise<unknown> | BadRequest,
) {
  // Always present on these routes, which all declare `:botId`. The fallback exists because this
  // helper is typed against a generic context that cannot know that, and a thrown "undefined bot"
  // would be a worse outcome than naming the one shared computer.
  const botId = context.req.param("botId") ?? "default";
  const record = context.var.actor;
  const body = (await context.req.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;

  try {
    const result = await handler(
      await seatFor(botId, record.id),
      actorOf(record),
      body,
      context.req.raw.signal,
    );
    if (isBadRequest(result)) {
      return context.json(result, 400);
    }
    return context.json(result as Record<string, unknown>);
  } catch (error) {
    return actionFailure(context, error);
  }
}

/**
 * The local actor's address, matched to decide whether the id is a real users row.
 *
 * Compared against rather than imported from `auth/dev-actor` because the computer must not depend on the
 * authentication module's internals; this is the one fact about it that matters here.
 */
const DEV_ACTOR_EMAIL = "dev@openbot.local";

/** The audit identity derived from the signed-in actor, with the same FK rule as every acting call. A Bot's browser's
 * routes, which sit under these, use it too (browser/bot-browser.ts). */
export function actorOf(record: AppVariables["actor"]): ActionActor {
  return {
    id: record.id,
    // Only a real users row may go in the audit table's foreign key column. The local development
    // actor is not one, so writing it there fails the constraint and loses the row entirely. Who
    // it was is recorded in the payload regardless. See gateway.ts.
    ...(record.email === DEV_ACTOR_EMAIL ? {} : { userId: record.id }),
  };
}

/**
 * One failure shape for JSON acting and binary download routes.
 *
 * A policy refusal names the rule; a workspace refusal does not, because there is no rule to edit.
 * Keeping both here means the download route cannot accidentally turn a boundary into a 500.
 */
function actionFailure(context: ComputerContext, error: unknown) {
  if (error instanceof ActionRefusedError) {
    return context.json({ error: error.message, rule: error.rule }, 403);
  }
  return context.json(errorBody(error), statusFor(error));
}

function isBadRequest(value: unknown): value is BadRequest {
  return (
    !!value &&
    typeof value === "object" &&
    "error" in value &&
    !("action" in value)
  );
}

function asRef(
  body: Record<string, unknown> | null,
): { ref: string; snapshotId: number } | undefined {
  if (typeof body?.ref !== "string" || !body.ref) return undefined;
  /*
   * A snapshot id is an integer the snapshot store handed out. `typeof` alone accepts `1.5` and
   * `Infinity` (valid JSON: `1e999` parses to it), which then never equals the stored integer, so
   * the gateway reports a stale snapshot and the caller retries a request that was malformed.
   * Malformed input is a 400 here, not a 409 staleness.
   */
  if (
    typeof body?.snapshotId !== "number" ||
    !Number.isInteger(body.snapshotId)
  ) {
    return undefined;
  }
  return { ref: body.ref, snapshotId: body.snapshotId };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

/**
 * Which HTTP status a failure deserves.
 *
 * Three genuinely different conditions that read identically if they all become 500: the computer is
 * not running (an operator fixes it), the refs are stale (the model fixes it by snapshotting again),
 * and everything else. Navigation established this; the acting routes follow it.
 */
/**
 * What a failed computer call looks like to the caller.
 *
 * One place, because the flag below decides what a Bot does next and a route that renders its own
 * error would silently not carry it. The computer marks a takeover on both the acting path and
 * navigate, and those two are answered by different code here, so the version of this that lived in
 * the acting helper alone fixed one of them.
 */
function errorBody(error: unknown): Record<string, unknown> {
  return {
    error: describe(error),
    // Not "the refs are stale, take another snapshot", which is what the surface says without it.
    ...(error instanceof HumanHasControlError
      ? {
          humanHasControl: true,
          requestId: error.requestId,
          handoff: error.handoff,
        }
      : {}),
    ...(error instanceof StaleSnapshotError
      ? {
          stale: true,
          ...(error.snapshotRequired ? { snapshotRequired: true } : {}),
        }
      : {}),
    ...(error instanceof HandoffRequestError
      ? { controlRequestError: true }
      : {}),
    /*
     * A cold start that outlasted the wait. Marked so the browser can draw a wait rather than a
     * failure, and tell the model the call was not performed and is worth repeating. Without the
     * flag it reads as any other unavailable computer, which sends a person looking for an outage.
     */
    ...(error instanceof ComputerStillStartingError
      ? { starting: true, notPerformed: true }
      : {}),
    /*
     * A rule asks about this call and it came without the conversation the asking happens in. Marked
     * so the browser sends the same call again through the approval route, which carries it.
     */
    ...(error instanceof ApprovalNeedsConversationError
      ? { needsConversation: true, notPerformed: true }
      : {}),
  };
}

function handoffId(body: Record<string, unknown> | null): string {
  if (
    typeof body?.requestId !== "string" ||
    !body.requestId.trim() ||
    body.requestId.length > 200
  )
    throw new HandoffRequestError("A requestId is required.", 400);
  return body.requestId;
}

function statusFor(error: unknown): 400 | 403 | 404 | 409 | 413 | 500 | 503 {
  if (error instanceof HandoffRequestError) return error.status;
  if (error instanceof StaleSnapshotError) return 409;
  // Same status as a stale snapshot and for the same reason: nothing is broken, the caller has to do
  // something else first. What differs is what that something is, which the body carries.
  if (error instanceof HumanHasControlError) return 409;
  // The same answer as a stale snapshot, because it is the same instruction: the refs are wrong, take
  // another snapshot. Not 503, which says the computer is unavailable and sends an operator hunting a
  // container that is running perfectly.
  if (error instanceof ElementNotFoundError) return 409;
  // Nothing is broken here either: the call has to come again with its conversation first.
  if (error instanceof ApprovalNeedsConversationError) return 409;
  // A person holding the wheel, or a person driving before taking it. Nothing is broken; the caller
  // has to wait or take control first, and 409 is how both of those are already reported.
  if (
    error instanceof ComputerUnavailableError &&
    /control/i.test(error.message)
  ) {
    return 409;
  }
  if (error instanceof WorkspaceRefusedError) return 403;
  if (error instanceof WorkspaceRequestError) return 400;
  if (error instanceof WorkspaceNotFoundError) return 404;
  if (error instanceof WorkspaceTooLargeError) return 413;
  if (error instanceof ComputerUnavailableError) return 503;
  return 500;
}
