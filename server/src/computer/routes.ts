import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { BotAccessCheck } from "../agents/profile-policy";
import type { AuditReader } from "../audit";
import type { AppVariables } from "../auth/guards";
import { requireAdmin } from "../auth/guards";
import { DEPLOYMENT_ROUTES } from "./deployment-routes";
import {
  type ActionActor,
  ActionRefusedError,
  controlLeaseBelongsTo,
  type ComputerGateway,
  ComputerUnavailableError,
  ElementNotFoundError,
  HumanHasControlError,
  NavigationRefusedError,
  StaleSnapshotError,
  WorkspaceRefusedError,
  WorkspaceRequestError,
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
) {
  const routes = new Hono<{ Variables: AppVariables }>();

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

    if (botId && !(await canUseBot(context.var.actor, botId))) {
      return context.json({ error: "There is no such Bot." }, 404);
    }
    await next();
  });

  routes.get("/:botId/status", async (context) => {
    const botId = context.req.param("botId");
    return context.json(await gateway.status(botId));
  });

  routes.get("/:botId/screenshot", async (context) => {
    try {
      return context.json(await gateway.screenshot(context.req.param("botId")));
    } catch (error) {
      return context.json(errorBody(error), statusFor(error));
    }
  });

  routes.get("/:botId/read", async (context) => {
    try {
      return context.json(await gateway.read(context.req.param("botId")));
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
      if (gateway.provider.isolation === "per-bot") return { ok: true };
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
    botId: string,
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
      const status = await gateway.status(botId);
      if (status.state !== "ready") {
        console.warn(
          `[computer] not keeping a frame for ${toolCallId}: the computer is ${status.state}, and photographing it would wake it.`,
        );
        return;
      }
      const shot = await gateway.screenshot(botId);
      const verdict = frameIsOfThisPage(shot.url, url);
      if (!verdict.ok) {
        console.warn(
          `[computer] not keeping a frame for ${toolCallId}: ${verdict.why} rather than ${url}.`,
        );
        return;
      }
      await pageFrames.save({
        computerId: botId,
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
      const botId = context.req.param("botId") ?? "default";
      const result = await gateway.navigate(
        botId,
        {
          id: context.var.actor.id,
          ...(context.var.actor.email === DEV_ACTOR_EMAIL
            ? {}
            : { userId: context.var.actor.id }),
        },
        body.url.trim(),
      );
      await keepFrameOf(botId, toolCallId, result.url, result.title);
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
      return context.json(await gateway.snapshot(context.req.param("botId")));
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
    act(context, (botId, actor, body, signal) => {
      const ref = asRef(body);
      if (!ref) return badRef;
      return gateway.click(botId, actor, ref, signal);
    }),
  );

  routes.post("/:botId/type", (context) =>
    act(context, (botId, actor, body, signal) => {
      const ref = asRef(body);
      if (!ref) return badRef;
      if (typeof body?.text !== "string") {
        return { error: "The text to enter is required." };
      }
      return gateway.type(
        botId,
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
    act(context, (botId, actor, body, signal) => {
      if (typeof body?.key !== "string" || !body.key) {
        return { error: "A key name is required, such as Enter or Tab." };
      }
      const ref = asRef(body);
      return gateway.key(
        botId,
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
    act(context, (botId, actor, body) =>
      gateway.scroll(botId, actor, {
        ...(typeof body?.deltaY === "number" ? { deltaY: body.deltaY } : {}),
      }),
    ),
  );

  /**
   * Who has the wheel. Polled by the surface next to the screen, so the person sees the Bot ask for
   * help without reloading anything.
   */
  routes.get("/:botId/control", async (context) => {
    try {
      return context.json(await gateway.control(context.req.param("botId")));
    } catch (error) {
      return context.json(errorBody(error), statusFor(error));
    }
  });

  routes.post("/:botId/control/request", (context) =>
    act(context, (botId, actor, body) =>
      gateway.requestHelp(
        botId,
        actor,
        typeof body?.reason === "string" && body.reason.trim()
          ? body.reason.trim()
          : "The assistant needs a person to continue.",
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
    act(context, (botId, actor) => gateway.stopComputer(botId, actor)),
  );

  /** Delete the profile. Every login goes with it, which is the point and also the danger. */
  routes.post("/:botId/computers/reset", (context) =>
    act(context, (botId, actor) => gateway.resetComputer(botId, actor)),
  );

  routes.post("/:botId/control/take", (context) =>
    act(context, (botId, actor) => gateway.takeControl(botId, actor)),
  );

  routes.post("/:botId/control/renew", (context) =>
    act(context, (botId, actor, body) => {
      if (typeof body?.lease !== "string") {
        return { error: "A control lease is required." };
      }
      if (!controlLeaseBelongsTo(body.lease, actor.id)) {
        return { error: "This control lease belongs to another session." };
      }
      return gateway.renewControl(botId, actor, body.lease);
    }),
  );

  routes.post("/:botId/control/release", (context) =>
    act(context, (botId, actor, body) => {
      if (typeof body?.lease !== "string") {
        return { error: "A control lease is required." };
      }
      if (!controlLeaseBelongsTo(body.lease, actor.id)) {
        return { error: "This control lease belongs to another session." };
      }
      return gateway.releaseControl(botId, actor, body.lease);
    }),
  );

  /** The Bot asking for a value it must not be told. */
  routes.post("/:botId/control/secret", (context) =>
    act(context, (botId, actor, body) => {
      if (typeof body?.ref !== "string" || !body.ref) {
        return {
          error:
            "Say which field the value goes in, using a ref from your snapshot.",
        };
      }
      if (typeof body?.snapshotId !== "number") {
        return { error: "The snapshotId the ref came from is required." };
      }
      return gateway.requestSecret(botId, actor, {
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
    act(context, (botId, actor, body) => {
      if (typeof body?.text !== "string" || !body.text) {
        return { error: "A value is required." };
      }
      return gateway.supplySecret(botId, actor, body.text);
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
    if (typeof body?.lease !== "string") {
      return context.json({ error: "A control lease is required." }, 400);
    }
    const actor = actionActorOf(context);
    if (!controlLeaseBelongsTo(body.lease, actor.id)) {
      return context.json(
        { error: "This control lease belongs to another session." },
        403,
      );
    }
    try {
      return context.json(
        await gateway.humanInput(
          context.req.param("botId"),
          actor,
          {
            ...body,
            // Last, so the checked value wins. Spread over it, a body carrying its own `kind` replaced
            // the one this route had just checked, and the gateway puts that value into the path it
            // calls on the computer.
            kind,
          } as Parameters<typeof gateway.humanInput>[2],
          body.lease,
        ),
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
    const stored = await pageFrames.load(
      context.req.param("botId"),
      context.req.param("toolCallId"),
    );
    return context.json({ frame: stored });
  });

  routes.post("/:botId/files/list", (context) =>
    act(context, (botId, actor, body) =>
      gateway.listFiles(botId, actor, {
        ...(typeof body?.path === "string" && body.path.trim()
          ? { path: body.path.trim() }
          : {}),
      }),
    ),
  );

  routes.post("/:botId/files/read", (context) =>
    act(context, (botId, actor, body) => {
      if (typeof body?.path !== "string" || !body.path.trim()) {
        return { error: "A file path is required." };
      }
      return gateway.readFile(botId, actor, { path: body.path.trim() });
    }),
  );

  /*
   * A command on the Bot's computer.
   *
   * Same shape as every other acting route: the gateway decides and records, this only shapes the
   * request. `timeoutMs` is passed through and capped by the computer rather than here, so one place
   * owns the limit.
   */
  routes.post("/:botId/exec", (context) =>
    act(context, (botId, actor, body, signal) => {
      if (typeof body?.command !== "string" || !body.command.trim()) {
        return { error: "A command is required." };
      }
      // The fourth argument, like every other acting route. Without it the plumbing through
      // gateway.runCommand and into the shell's own abort listener was dead code, and Stop ended the
      // run in the transcript while the command carried on to completion inside the container.
      return gateway.runCommand(
        botId,
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
    act(context, (botId, actor, body) => {
      if (typeof body?.path !== "string" || !body.path.trim()) {
        return { error: "A file path is required." };
      }
      if (typeof body?.contents !== "string") {
        return { error: "The contents to write are required." };
      }
      return gateway.writeFile(botId, actor, {
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
            "That rule could not be saved, so it has not been applied. The previous boundary is still in force.",
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
    const requested = typeof body?.limit === "number" ? body.limit : 200;
    const limit = Math.min(Math.max(Math.trunc(requested), 1), 500);

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

function actionActorOf(context: ComputerContext): ActionActor {
  const record = context.var.actor;
  return {
    id: record.id,
    ...(record.email === DEV_ACTOR_EMAIL ? {} : { userId: record.id }),
  };
}

/** A request that was rejected before any decision was needed, because it was not a valid action. */
type BadRequest = { error: string };

const badRef: BadRequest = {
  error:
    "A ref and the snapshotId it came from are both required. Take a snapshot first.",
};

/**
 * Shared plumbing for acting routes that use this helper: resolve who is asking, run, and map
 * failures onto statuses.
 *
 * One place, so a new acting route cannot accidentally report a policy refusal as a server error, and
 * so the actor is derived the same way every time.
 */
async function act(
  context: ComputerContext,
  handler: (
    botId: string,
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
  const body = (await context.req.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;

  try {
    const result = await handler(
      botId,
      // Only a real users row may go in the audit table's foreign key column. The local development
      // actor is not one, so writing it there fails the constraint and loses the row entirely. Who
      // it was is recorded in the payload regardless. See gateway.ts.
      actionActorOf(context),
      body,
      context.req.raw.signal,
    );
    if (isBadRequest(result)) {
      return context.json(result, 400);
    }
    return context.json(result as Record<string, unknown>);
  } catch (error) {
    // A policy refusal is the product working. 403 with the rule that refused it, so the surface can
    // tell the person which boundary they met rather than reporting a malfunction.
    if (error instanceof ActionRefusedError) {
      return context.json({ error: error.message, rule: error.rule }, 403);
    }
    // The computer refused the path itself, which is a different thing from the policy refusing this
    // Bot. Same status, no rule attached, because there is no rule to go and edit.
    if (error instanceof WorkspaceRefusedError) {
      return context.json({ error: error.message }, 403);
    }
    // A 400, deliberately, NOT a 403. The surface treats 403 as "a boundary refused you" and renders
    // it as Blocked, so returning it for "there is no file at notes.md" told both the person and the
    // model that a policy had intervened when none had.
    if (error instanceof WorkspaceRequestError) {
      return context.json({ error: error.message }, 400);
    }
    return context.json(errorBody(error), statusFor(error));
  }
}

/**
 * The local actor's address, matched to decide whether the id is a real users row.
 *
 * Compared against rather than imported from `auth/dev-actor` because the computer must not depend on the
 * authentication module's internals; this is the one fact about it that matters here.
 */
const DEV_ACTOR_EMAIL = "dev@openbot.local";

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
  if (typeof body?.snapshotId !== "number") return undefined;
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
    ...(error instanceof HumanHasControlError ? { humanHasControl: true } : {}),
  };
}

function statusFor(error: unknown): 409 | 500 | 503 {
  if (error instanceof StaleSnapshotError) return 409;
  // Same status as a stale snapshot and for the same reason: nothing is broken, the caller has to do
  // something else first. What differs is what that something is, which the body carries.
  if (error instanceof HumanHasControlError) return 409;
  // The same answer as a stale snapshot, because it is the same instruction: the refs are wrong, take
  // another snapshot. Not 503, which says the computer is unavailable and sends an operator hunting a
  // container that is running perfectly.
  if (error instanceof ElementNotFoundError) return 409;
  // A person holding the wheel, or a person driving before taking it. Nothing is broken; the caller
  // has to wait or take control first, and 409 is how both of those are already reported.
  if (
    error instanceof ComputerUnavailableError &&
    /control/i.test(error.message)
  ) {
    return 409;
  }
  if (error instanceof ComputerUnavailableError) return 503;
  return 500;
}
