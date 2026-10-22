import {
  type BrowserApiState,
  type BrowserOpenRequest,
  type BrowserOpenResponse,
  type BrowserProduct,
  type BrowserState,
  type BrowserWindow,
  browserComputerPaths,
  browserNavigateRequestSchema,
  browserNarrationRequestSchema,
  browserOpenRequestSchema,
  browserRecordingRequestSchema,
  browserTabsRequestSchema,
  type Narration,
} from "@openbot/shared/openbot-browser";
import { RECORDER_EXTENSION_ID } from "@openbot/shared/recorder-extension";
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { z } from "zod";
import type { AuditStore } from "../audit";
import type { AppVariables } from "../auth/guards";
import { checkComputerAddress } from "../computer/target";
import { recorderAudit, recorderConnected } from "../recorder/connected";
import type { RecorderExtensionDeps } from "../recorder/wiring";
import { personBrowserId, personBrowserInstallId } from "./person";

/** What the person sees their OpenBot browser called in Settings, Browsers, and what its connection's trail names. */
export const OPENBOT_BROWSER_LABEL = "OpenBot browser";

/** Where people's browsers run here: the computers carry them as they carry Bots' (browser/host.ts). */
export type BrowserComputers = {
  /** The browser's computer, started when it must be. Throws when it cannot be reached. */
  locate(computerId: string): Promise<string>;
  /** Whether its computer is up, never starting it: the Browser page asks every few seconds, and asking must not start
   * a computer for everybody who opens OpenBot. */
  running(computerId: string): Promise<boolean>;
};

export type BrowserRouteDeps = {
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
  /** Absent when this OpenBot has no way to run a person's browser: the state says so and the app hides the button. */
  computers?: BrowserComputers;
  /** The computer token, the same one every computer requires. */
  token?: string;
  /** The Recorder's connections and what goes with them (recorder/wiring.ts). */
  recorder: Pick<
    RecorderExtensionDeps,
    "connections" | "user" | "sealOrganizationSession" | "onConnected"
  >;
  /** The address the person's browser reaches this OpenBot at (browser/address.ts), from the request's Origin; null
   * when there is none the Recorder would accept. */
  openbotUrl: (requestOrigin: string | undefined) => string | null;
  auditStore?: AuditStore;
  fetchImpl?: typeof fetch;
};

/** Narration is the largest body here: 4,000 characters of one phrase, as UTF-8, with room for the rest. */
const BODY_LIMIT_BYTES = 16 * 1024;
/** Launching a browser, loading the Recorder and handing it its connection takes seconds; a cold computer more. */
const OPEN_TIMEOUT_MS = 90_000;
const CALL_TIMEOUT_MS = 30_000;

const SENTENCES = {
  unavailable: "This OpenBot cannot open a browser for you.",
  noAddress:
    "This OpenBot has no address your browser can reach it at. An admin sets OPENBOT_PUBLIC_URL to its https address.",
  tooMany:
    "Too many connection codes were asked for at once. Wait a few minutes and try again.",
  notConnected: "Your browser could not be connected. Try again.",
  noPerson: "This person could not be found. Try again.",
  unreachable: "Your browser could not be reached. Try again.",
  unclear: "Your browser opened but did not say how. Try again.",
  notWeb: "Only web addresses open here.",
} as const;

class BrowserUnreachableError extends Error {}

/** A cross-site form can only send these three content types, so requiring JSON stops one. */
const jsonOnly: MiddlewareHandler = async (context, next) => {
  if (!context.req.header("content-type")?.startsWith("application/json")) {
    return context.json({ error: "Send the request as JSON." }, 415);
  }
  await next();
};

const smallBody = bodyLimit({
  maxSize: BODY_LIMIT_BYTES,
  onError: (context) =>
    context.json({ error: "That request is too large." }, 413),
});

/** A browser's state as the computer reports it, checked for the two fields every answer has. */
function browserState(value: unknown): BrowserState | null {
  if (typeof value !== "object" || value === null) return null;
  const state = value as Partial<BrowserState>;
  return typeof state.open === "boolean" && Array.isArray(state.tabs)
    ? (value as BrowserState)
    : null;
}

/** Who hears the person: the Recorder says, and before it has, the window does (a native window has a microphone, a
 * screen does not). */
function narrationOf(state: BrowserState): Narration | undefined {
  if (state.recorder?.narration) return state.recorder.narration;
  if (state.window === "native") return "own";
  if (state.window === "screen") return "external";
  return undefined;
}

/**
 * Whether an address the person typed may be opened: a web address, or one with no scheme for the browser to read as
 * one. Never `file:`, `chrome:`, `javascript:` or `data:`: on a computer in the cloud the first reads the computer's own
 * disk, where other people's browser profiles are kept. `example.com:8080` is a host and port, not a scheme.
 */
export function isWebAddress(input: string): boolean {
  const scheme = /^([a-z][a-z0-9+.-]*):(?!\d)/i.exec(input.trim())?.[1];
  return (
    scheme === undefined || ["http", "https"].includes(scheme.toLowerCase())
  );
}

/**
 * The person's own OpenBot browser: open it, see it, record in it, narrate, move between its tabs and close it. Every
 * route is the signed-in person's own browser, named from who is asking (browser/person.ts), so there is no id in the
 * path to ask for anybody else's.
 *
 * Opening it connects the Recorder in it as this person with no Connect step: OpenBot mints the connection itself, as
 * the exchange would (recorder/connections.ts), sealing the person's organization session from this request as the
 * connect-code route does, and hands it to the computer, which hands it to the Recorder over the DevTools pipe only the
 * launcher holds. It is one more connected browser, in Settings, Browsers like any other, and can be disconnected there.
 */
export function createBrowserRoutes(deps: BrowserRouteDeps) {
  const routes = new Hono<{ Variables: AppVariables }>();
  const audit = recorderAudit(deps.auditStore);
  const doFetch = deps.fetchImpl ?? fetch;

  /** One computer route for this person's browser, under the computer token with the browser in `x-openbot-bot-id`. */
  async function ask(
    base: string,
    computerId: string,
    path: string,
    body?: unknown,
    timeoutMs = CALL_TIMEOUT_MS,
  ): Promise<{ status: number; body: unknown }> {
    const checked = checkComputerAddress(base);
    if (!checked.allowed) throw new BrowserUnreachableError(checked.reason);
    let response: Response;
    try {
      response = await doFetch(`${base.replace(/\/$/, "")}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          "x-openbot-bot-id": computerId,
          ...(deps.token ? { "x-openbot-computer-token": deps.token } : {}),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      console.error(
        JSON.stringify({
          type: "browser-computer-unreachable",
          path,
          error: error instanceof Error ? error.name : String(error),
        }),
      );
      throw new BrowserUnreachableError(SENTENCES.unreachable);
    }
    return {
      status: response.status,
      body: await response.json().catch(() => null),
    };
  }

  /** The computer's refusal, said as it said it: its own 4xx with its own sentence, anything else a 502. */
  function refused(answer: { status: number; body: unknown }): Response {
    const said = (answer.body as { error?: unknown } | null)?.error;
    const error =
      typeof said === "string" && said ? said : SENTENCES.unreachable;
    const status =
      answer.status >= 400 && answer.status < 500 ? answer.status : 502;
    return Response.json({ error }, { status });
  }

  function unreachable(error: unknown): Response {
    return Response.json(
      {
        error:
          error instanceof BrowserUnreachableError
            ? error.message
            : SENTENCES.unreachable,
      },
      { status: 502 },
    );
  }

  const closed = (computerId: string, available: boolean): BrowserApiState => ({
    available,
    computerId,
    open: false,
    tabs: [],
  });

  const view = (computerId: string, state: BrowserState): BrowserApiState => {
    const narration = narrationOf(state);
    return {
      ...state,
      available: true,
      computerId,
      ...(narration ? { narration } : {}),
    };
  };

  /** The browser as it is now, for the person to see. Never fails for the computer: a browser that cannot be asked is
   * one that is not open, and opening it says why. */
  async function currentState(computerId: string): Promise<BrowserApiState> {
    const computers = deps.computers;
    if (!computers) return closed(computerId, false);
    try {
      if (!(await computers.running(computerId)))
        return closed(computerId, true);
      const base = await computers.locate(computerId);
      const answer = await ask(base, computerId, browserComputerPaths.state);
      const state = answer.status === 200 ? browserState(answer.body) : null;
      return state ? view(computerId, state) : closed(computerId, true);
    } catch {
      return closed(computerId, true);
    }
  }

  /** Forwards one request to the person's browser. `answer` is what the person is told when it was taken: the browser's
   * state after it, by default, as the contract's routes answer. */
  async function forward(
    computerId: string,
    path: string,
    body: unknown,
    answer: (state: BrowserState | null) => Promise<unknown> = async (state) =>
      state ? view(computerId, state) : currentState(computerId),
  ): Promise<Response> {
    const computers = deps.computers;
    if (!computers)
      return Response.json({ error: SENTENCES.unavailable }, { status: 503 });
    try {
      const base = await computers.locate(computerId);
      const taken = await ask(base, computerId, path, body);
      if (taken.status < 200 || taken.status >= 300) return refused(taken);
      return Response.json(await answer(browserState(taken.body)));
    } catch (error) {
      return unreachable(error);
    }
  }

  /** The body, read against the contract's schema; null when it does not match. */
  async function parsed<T extends z.ZodType>(
    request: Request,
    schema: T,
  ): Promise<z.infer<T> | null> {
    const body = schema.safeParse(await request.json().catch(() => null));
    return body.success ? body.data : null;
  }

  routes.get("/", deps.requireUser, async (context) =>
    context.json(await currentState(personBrowserId(context.var.actor.id))),
  );

  routes.post("/open", deps.requireUser, async (context) => {
    const actor = context.var.actor;
    const computerId = personBrowserId(actor.id);
    const computers = deps.computers;
    if (!computers) return context.json({ error: SENTENCES.unavailable }, 503);
    const openbotUrl = deps.openbotUrl(context.req.header("origin"));
    if (!openbotUrl) return context.json({ error: SENTENCES.noAddress }, 503);

    // The connection, minted here and exchanged at once, as the Recorder's own exchange would: the same store, the same
    // checks, the sealed organization session carried from this request. Its install id is the browser's, so this open
    // revokes the token the last one made, in the same transaction, rather than adding another.
    const minted = await deps.recorder.connections.mintCode(
      actor.id,
      "openbot-browser",
      await deps.recorder.sealOrganizationSession(context.req.header("cookie")),
    );
    if (!minted) return context.json({ error: SENTENCES.tooMany }, 429);
    const made = await deps.recorder.connections.exchange({
      code: minted.code,
      label: OPENBOT_BROWSER_LABEL,
      extensionId: RECORDER_EXTENSION_ID,
      installId: personBrowserInstallId(computerId),
    });
    if (!made) return context.json({ error: SENTENCES.notConnected }, 500);
    await recorderConnected({
      made,
      audit,
      onConnected: deps.recorder.onConnected,
    });
    const user = await deps.recorder.user(actor.id);
    if (!user) return context.json({ error: SENTENCES.noPerson }, 500);

    const request = browserOpenRequestSchema.safeParse({
      connection: {
        openbotUrl,
        token: made.token,
        connectionId: made.connection.id,
        user: {
          id: user.id,
          name: user.name.slice(0, 200),
          email: user.email.slice(0, 320),
        },
      },
    } satisfies BrowserOpenRequest);
    if (!request.success)
      return context.json({ error: SENTENCES.notConnected }, 500);

    let state: BrowserState | null;
    try {
      const base = await computers.locate(computerId);
      const answer = await ask(
        base,
        computerId,
        browserComputerPaths.open,
        request.data,
        OPEN_TIMEOUT_MS,
      );
      if (answer.status < 200 || answer.status >= 300) return refused(answer);
      state = browserState(answer.body);
      // The computer answers its state; one that answered something else is asked for it.
      if (!state?.browser || !state.window) {
        const asked = await ask(base, computerId, browserComputerPaths.state);
        state = asked.status === 200 ? browserState(asked.body) : null;
      }
    } catch (error) {
      return unreachable(error);
    }
    const browser: BrowserProduct | undefined = state?.browser;
    const window: BrowserWindow | undefined = state?.window;
    const narration = state ? narrationOf(state) : undefined;
    if (!browser || !window || !narration)
      return context.json({ error: SENTENCES.unclear }, 502);
    const answer: BrowserOpenResponse = {
      ok: true,
      computerId,
      browser,
      window,
      narration,
    };
    return context.json(answer);
  });

  routes.post(
    "/recording",
    deps.requireUser,
    jsonOnly,
    smallBody,
    async (context) => {
      const body = await parsed(context.req.raw, browserRecordingRequestSchema);
      if (!body)
        return context.json({ error: "Name what you are about to do." }, 400);
      return forward(
        personBrowserId(context.var.actor.id),
        browserComputerPaths.recording,
        body,
      );
    },
  );

  // Answered with nothing more than that it was taken: a phrase comes every few seconds while the person talks, and
  // the page polls the state on its own.
  routes.post(
    "/narration",
    deps.requireUser,
    jsonOnly,
    smallBody,
    async (context) => {
      const body = await parsed(context.req.raw, browserNarrationRequestSchema);
      if (!body || body.endedAt < body.startedAt)
        return context.json({ error: "That phrase was not complete." }, 400);
      return forward(
        personBrowserId(context.var.actor.id),
        browserComputerPaths.narration,
        body,
        async () => ({ ok: true }),
      );
    },
  );

  routes.post(
    "/tabs",
    deps.requireUser,
    jsonOnly,
    smallBody,
    async (context) => {
      const body = await parsed(context.req.raw, browserTabsRequestSchema);
      if (!body)
        return context.json({ error: "That tab could not be found." }, 400);
      if (body.action === "new" && body.url && !isWebAddress(body.url))
        return context.json({ error: SENTENCES.notWeb }, 400);
      return forward(
        personBrowserId(context.var.actor.id),
        browserComputerPaths.tabs,
        body,
      );
    },
  );

  routes.post(
    "/navigate",
    deps.requireUser,
    jsonOnly,
    smallBody,
    async (context) => {
      const body = await parsed(context.req.raw, browserNavigateRequestSchema);
      if (!body) return context.json({ error: "Type an address." }, 400);
      if ("url" in body && !isWebAddress(body.url))
        return context.json({ error: SENTENCES.notWeb }, 400);
      return forward(
        personBrowserId(context.var.actor.id),
        browserComputerPaths.navigate,
        body,
      );
    },
  );

  routes.post("/close", deps.requireUser, async (context) =>
    forward(
      personBrowserId(context.var.actor.id),
      browserComputerPaths.close,
      {},
    ),
  );

  return routes;
}
