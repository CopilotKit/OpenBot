import { describe, expect, test } from "bun:test";
import {
  type AbstractAgent,
  type BaseEvent,
  EventType,
  HttpAgent,
  type RunAgentInput,
} from "@ag-ui/client";
import { Hono } from "hono";
import { Observable } from "rxjs";
import { parseApprovalContinuation } from "../src/approvals/types";
import type { AuditEventInput, AuditStore } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import type { ComputerGateway } from "../src/computer/gateway";
import {
  createHeadlessComputerTools,
  HeadlessToolSuspension,
} from "../src/computer/headless-tools";
import type { SignInFillInput, SignInFillResult } from "../src/computer/schema";
import {
  createPasswordRoutes,
  createSignInRoutes,
} from "../src/passwords/routes";
import {
  createSignInService,
  signInToolResult,
} from "../src/passwords/service";
import { createMemoryPasswordStore } from "../src/passwords/store";
import { originOf, type SignInRequestRecord } from "../src/passwords/types";
import { createTurnRunner, type RunnerLike } from "../src/routines/run-turn";

/**
 * The private sign-in request and the Passwords vault, as properties:
 *  - a submitted password never appears in an AG-UI event, a model request, a stored row, an audit
 *    payload or a route response;
 *  - the computer is the only thing that receives it;
 *  - a saved login is used only when its owner confirms it, only on its own origin, and only while
 *    the password manager is on.
 */

const PASSWORD = "Tr0ub4dor&3-never-show-me";
const USERNAME = "alice.private@example.test";
const CODE = "918273";
const KEY = Buffer.alloc(32, 7).toString("base64");

function fakeGateway(result: Partial<SignInFillResult> = {}) {
  const fills: SignInFillInput[] = [];
  const helps: string[] = [];
  const gateway: Pick<ComputerGateway, "signIn" | "requestHelp"> = {
    async signIn(_botId, input) {
      fills.push(input);
      return {
        submitted: true,
        passwordFieldVisible: false,
        url: "https://example.com/home",
        ...result,
      };
    },
    async requestHelp(_botId, _actor, reason) {
      helps.push(reason);
      return {
        holder: "bot",
        request: { id: "control-1" },
      } as unknown as Awaited<ReturnType<ComputerGateway["requestHelp"]>>;
    },
  };
  return { gateway, fills, helps };
}

function audit() {
  const rows: AuditEventInput[] = [];
  const store: AuditStore = { insert: async (event) => void rows.push(event) };
  return { rows, store };
}

function setup(
  options: { manager?: boolean; fill?: Partial<SignInFillResult> } = {},
) {
  const store = createMemoryPasswordStore();
  const computer = fakeGateway(options.fill);
  const trail = audit();
  const resolved: SignInRequestRecord[] = [];
  const service = createSignInService({
    store,
    gateway: computer.gateway,
    encryptionKey: KEY,
    auditStore: trail.store,
    passwordManagerEnabled: async () => options.manager ?? true,
    onResolved: async (request) => void resolved.push(request),
  });
  return { store, computer, trail, service, resolved };
}

const actor = {
  id: "owner",
  userId: "owner",
  initiator: { kind: "person" as const },
};

function everything(...values: unknown[]) {
  return JSON.stringify(values);
}

function expectNoCredential(text: string) {
  expect(text).not.toContain(PASSWORD);
  expect(text).not.toContain(CODE);
}

describe("the site a login belongs to", () => {
  test("is an exact origin, never a path, and never carries credentials", () => {
    expect(originOf("example.com/login?next=/")).toBe("https://example.com");
    expect(originOf("http://127.0.0.1:8080/x")).toBe("http://127.0.0.1:8080");
    expect(() => originOf("ftp://example.com")).toThrow();
    expect(() => originOf("https://user:pw@example.com")).toThrow();
  });
});

describe("a sign-in request answered with a typed login", () => {
  test("types it through the computer and tells the Bot only that it worked", async () => {
    const { service, computer, trail, store, resolved } = setup();
    const request = await service.request({
      ownerUserId: "owner",
      botId: "bot",
      site: "https://example.com/login",
      reason: "to read the dashboard",
      actor,
    });
    const view = await service.submit("owner", request.id, actor, {
      username: USERNAME,
      password: PASSWORD,
      code: CODE,
      save: true,
    });
    expect(view.status).toBe("signed_in");
    expect(computer.fills).toEqual([
      {
        origin: "https://example.com",
        username: USERNAME,
        password: PASSWORD,
        code: CODE,
      },
    ]);
    const done = resolved[0];
    if (!done) throw new Error("not resolved");
    const toolResult = signInToolResult(done);
    expect(toolResult).toMatchObject({
      ok: true,
      signedIn: true,
      site: "https://example.com",
    });
    // Saved, encrypted.
    const [saved] = await store.logins("owner");
    expect(saved?.username).toBe(USERNAME);
    expect(saved?.encryptedPassword).not.toContain(PASSWORD);
    const logins = await service.logins("owner");
    expectNoCredential(
      everything(
        view,
        toolResult,
        trail.rows,
        [...store.requests.values()],
        logins,
      ),
    );
    // And no username in the audit trail or the Bot's answer either.
    expect(everything(trail.rows, toolResult)).not.toContain(USERNAME);
    // Saved after the sign-in is recorded, so a failed save cannot leave the request half done.
    expect(trail.rows.map((row) => row.eventType)).toEqual([
      "computer.sign_in_requested",
      "computer.sign_in_completed",
      "password.saved",
    ]);
  });

  test("a login the site rejects reopens the request and stores nothing", async () => {
    const { service, store, trail } = setup({
      fill: { passwordFieldVisible: true },
    });
    const request = await service.request({
      ownerUserId: "owner",
      botId: "bot",
      site: "example.com",
      actor,
    });
    await expect(
      service.submit("owner", request.id, actor, {
        username: USERNAME,
        password: PASSWORD,
        save: true,
      }),
    ).rejects.toThrow(/password field/);
    expect((await service.get("owner", request.id)).status).toBe("pending");
    expect(await store.logins("owner")).toEqual([]);
    expectNoCredential(everything(trail.rows, [...store.requests.values()]));
  });

  test("an error the computer words is scrubbed of anything the person typed", async () => {
    const { service, trail, store } = setup({
      fill: { error: `could not type ${PASSWORD} into the field` },
    });
    const request = await service.request({
      ownerUserId: "owner",
      botId: "bot",
      site: "example.com",
      actor,
    });
    const failure = await service
      .submit("owner", request.id, actor, { password: PASSWORD })
      .catch((error: Error) => error.message);
    expectNoCredential(
      everything(failure, trail.rows, [...store.requests.values()]),
    );
  });
});

describe("a saved login", () => {
  async function withSaved(options: { manager?: boolean } = {}) {
    const context = setup(options);
    const first = await context.service.request({
      ownerUserId: "owner",
      botId: "bot",
      site: "example.com",
      actor,
    });
    await context.service.submit("owner", first.id, actor, {
      username: USERNAME,
      password: PASSWORD,
      save: true,
    });
    const [login] = await context.store.logins("owner");
    if (!login) throw new Error("not saved");
    context.computer.fills.length = 0;
    return { ...context, login };
  }

  test("is offered by username only, and used only when its owner confirms it", async () => {
    const { service, computer, login } = await withSaved();
    const next = await service.request({
      ownerUserId: "owner",
      botId: "bot",
      site: "https://example.com/other",
      actor,
    });
    const view = await service.get("owner", next.id);
    expect(view.savedLogins).toEqual([{ id: login.id, username: USERNAME }]);
    expectNoCredential(JSON.stringify(view));
    // Nothing is typed until the owner chooses it.
    expect(computer.fills).toEqual([]);
    const done = await service.useSaved("owner", next.id, actor, {
      loginId: login.id,
    });
    expect(done.status).toBe("signed_in");
    expect(done.method).toBe("saved");
    expect(computer.fills).toEqual([
      { origin: "https://example.com", username: USERNAME, password: PASSWORD },
    ]);
  });

  test("is never typed into another origin", async () => {
    const { service, computer, login } = await withSaved();
    const elsewhere = await service.request({
      ownerUserId: "owner",
      botId: "bot",
      site: "https://example.com.evil.test",
      actor,
    });
    expect((await service.get("owner", elsewhere.id)).savedLogins).toEqual([]);
    await expect(
      service.useSaved("owner", elsewhere.id, actor, { loginId: login.id }),
    ).rejects.toThrow(/not for this site/);
    expect(computer.fills).toEqual([]);
  });

  test("belongs to its owner alone", async () => {
    const { service, login } = await withSaved();
    const theirs = await service.request({
      ownerUserId: "stranger",
      botId: "bot",
      site: "example.com",
      actor: { id: "stranger", userId: "stranger" },
    });
    await expect(
      service.useSaved("stranger", theirs.id, actor, { loginId: login.id }),
    ).rejects.toThrow(/not for this site/);
    await expect(service.get("stranger", "missing")).rejects.toThrow(/no such/);
    expect((await service.logins("stranger")).logins).toEqual([]);
  });

  test("is neither offered nor saved while the password manager is off", async () => {
    const context = setup({ manager: false });
    const request = await context.service.request({
      ownerUserId: "owner",
      botId: "bot",
      site: "example.com",
      actor,
    });
    const view = await context.service.get("owner", request.id);
    expect(view.passwordManager).toBe(false);
    await expect(
      context.service.submit("owner", request.id, actor, {
        username: USERNAME,
        password: PASSWORD,
        save: true,
      }),
    ).rejects.toThrow(/turned off/);
    expect(await context.store.logins("owner")).toEqual([]);
  });
});

describe("the other answers", () => {
  test("take over hands the person the browser, and finishing tells the Bot", async () => {
    const { service, computer, resolved } = setup();
    const request = await service.request({
      ownerUserId: "owner",
      botId: "bot",
      site: "example.com",
      actor,
    });
    const taken = await service.takeOver("owner", request.id, actor);
    expect(taken.status).toBe("taken_over");
    expect(taken.controlRequestId).toBe("control-1");
    expect(computer.helps[0]).toContain("Sign in to https://example.com");
    const done = await service.finishTakeover("owner", request.id, actor);
    expect(done.method).toBe("takeover");
    expect(resolved).toHaveLength(1);
  });

  test("declining closes it, and the Bot is told not to ask another way", async () => {
    const { service, resolved } = setup();
    const request = await service.request({
      ownerUserId: "owner",
      botId: "bot",
      site: "example.com",
      actor,
    });
    await service.cancel("owner", request.id, actor);
    const result = signInToolResult(resolved[0] as SignInRequestRecord);
    expect(result.signedIn).toBe(false);
    expect(result.result).toContain("Do not ask for the login another way");
    await expect(
      service.submit("owner", request.id, actor, { password: PASSWORD }),
    ).rejects.toThrow(/no longer open/);
  });

  test("an expired request closes itself", async () => {
    const store = createMemoryPasswordStore();
    const service = createSignInService({
      store,
      gateway: fakeGateway().gateway,
      encryptionKey: KEY,
      ttlMs: -1,
    });
    const request = await service.request({
      ownerUserId: "owner",
      botId: "bot",
      site: "example.com",
      actor,
    });
    expect((await service.get("owner", request.id)).status).toBe("expired");
  });
});

describe("the routes", () => {
  function app(context: ReturnType<typeof setup>) {
    const requireUser = async (
      c: { set: (key: "actor", value: AppVariables["actor"]) => void },
      next: () => Promise<void>,
    ) => {
      c.set("actor", {
        id: "owner",
        email: "owner@example.test",
      } as AppVariables["actor"]);
      await next();
    };
    const root = new Hono<{ Variables: AppVariables }>();
    root.route(
      "/api/sign-in-requests",
      createSignInRoutes(
        context.service,
        requireUser as never,
        async (_actor, botId) => botId === "bot",
      ),
    );
    root.route(
      "/api/passwords",
      createPasswordRoutes(context.service, requireUser as never),
    );
    return root;
  }
  const post = (path: string, body: unknown) =>
    new Request(`http://127.0.0.1${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  test("never answer with a credential, and refuse a Bot the person cannot use", async () => {
    const context = setup();
    const server = app(context);
    const refused = await server.fetch(
      post("/api/sign-in-requests", { botId: "other", site: "example.com" }),
    );
    expect(refused.status).toBe(404);
    const created = await server.fetch(
      post("/api/sign-in-requests", { botId: "bot", site: "example.com" }),
    );
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    const submitted = await server.fetch(
      post(`/api/sign-in-requests/${id}/submit`, {
        username: USERNAME,
        password: PASSWORD,
        code: CODE,
        save: true,
      }),
    );
    expect(submitted.status).toBe(200);
    const bodies = [
      await submitted.text(),
      await (
        await server.fetch(
          new Request(`http://127.0.0.1/api/sign-in-requests/${id}`),
        )
      ).text(),
      await (
        await server.fetch(new Request("http://127.0.0.1/api/passwords"))
      ).text(),
    ];
    for (const body of bodies) expectNoCredential(body);
    expect(bodies[2]).toContain(USERNAME);
  });

  test("an unexpected failure is one fixed sentence, not the error it came from", async () => {
    const context = setup();
    context.store.createRequest = async () => {
      throw new Error(`Failed query: insert ... params: ${PASSWORD}`);
    };
    const response = await app(context).fetch(
      post("/api/sign-in-requests", { botId: "bot", site: "example.com" }),
    );
    expect(response.status).toBe(500);
    expectNoCredential(await response.text());
  });
});

/*
 * The whole path an unattended Bot takes, through the real headless middleware and turn runner:
 * the Bot asks, the turn pauses, the person answers in the form, and the turn resumes. Every AG-UI
 * event, every request the model receives, every audit row and every stored row is then searched
 * for the password.
 */
describe("an unattended turn that needs a sign-in", () => {
  function lifecycle(input: RunAgentInput, body: BaseEvent[]) {
    return [
      {
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
      },
      ...body,
      {
        type: EventType.RUN_FINISHED,
        threadId: input.threadId,
        runId: input.runId,
      },
    ];
  }
  function remoteTurn(
    events: (input: RunAgentInput, index: number) => BaseEvent[],
  ) {
    const requests: RunAgentInput[] = [];
    const agent = new HttpAgent({
      agentId: "bot",
      url: "https://agent.example/ag-ui",
      fetch: async (_url, init) => {
        const request = JSON.parse(String(init.body)) as RunAgentInput;
        requests.push(request);
        return new Response(
          events(request, requests.length - 1)
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join(""),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    return { requests, agent };
  }
  function harness(agent: AbstractAgent, tools: () => Promise<unknown[]>) {
    const persisted: BaseEvent[] = [];
    const runner: RunnerLike = {
      run: ({ agent: selected, input }) =>
        new Observable((subscriber) => {
          selected
            .runAgent(input, {
              onEvent: ({ event }) => {
                persisted.push(event);
                subscriber.next(event);
              },
            })
            .then(
              () => subscriber.complete(),
              (error) => subscriber.error(error),
            );
        }),
      stop: async () => true,
    };
    const run = createTurnRunner({
      intelligence: {
        getOrCreateThread: async () => undefined,
        getThreadMessages: async () => ({ messages: [] }),
        ɵacquireThreadLock: async () => undefined,
        ɵrenewThreadLock: async () => undefined,
        ɵcleanupThreadLock: async () => undefined,
      },
      runner,
      buildAgentFor: async () => agent,
      toolsForTurn: tools as never,
    });
    return { persisted, run };
  }

  test("pauses, resumes with the outcome, and never carries the password", async () => {
    const context = setup();
    const remote = remoteTurn((input, index) =>
      lifecycle(
        input,
        index === 0
          ? [
              {
                type: EventType.TOOL_CALL_START,
                toolCallId: "sign-in-call",
                toolCallName: "computer_request_sign_in",
                parentMessageId: "message-1",
              },
              {
                type: EventType.TOOL_CALL_ARGS,
                toolCallId: "sign-in-call",
                delta: JSON.stringify({ site: "https://example.com/login" }),
              },
              { type: EventType.TOOL_CALL_END, toolCallId: "sign-in-call" },
            ]
          : [
              {
                type: EventType.TEXT_MESSAGE_START,
                messageId: "reply",
                role: "assistant",
              },
              {
                type: EventType.TEXT_MESSAGE_CONTENT,
                messageId: "reply",
                delta: "I am in.",
              },
              { type: EventType.TEXT_MESSAGE_END, messageId: "reply" },
            ],
      ),
    );
    const tools = async () =>
      createHeadlessComputerTools({
        gateway: {} as ComputerGateway,
        botId: "bot",
        actor,
        signIn: context.service,
      }).filter((tool) => tool.definition.name === "computer_request_sign_in");
    const { persisted, run } = harness(remote.agent, tools);
    const paused = await run({
      ownerUserId: "owner",
      routineId: "routine",
      agentId: "bot",
      threadId: "thread",
      instruction: "Check the dashboard",
    }).catch((error: unknown) => error);
    expect(paused).toBeInstanceOf(HeadlessToolSuspension);
    const waiting = (paused as HeadlessToolSuspension).waiting;
    expect(waiting.kind).toBe("computer_sign_in");
    const requestId = String(waiting.signInRequestId);

    await context.service.submit("owner", requestId, actor, {
      username: USERNAME,
      password: PASSWORD,
      code: CODE,
      save: true,
    });
    const done = context.resolved[0];
    if (!done?.continuation) throw new Error("no continuation saved");
    const snapshot = parseApprovalContinuation(done.continuation);
    expect(snapshot.toolCallId).toBe("sign-in-call");
    const resumed = await run({
      ownerUserId: "owner",
      routineId: "routine",
      agentId: "bot",
      threadId: "thread",
      instruction: "",
      continuation: {
        snapshot,
        result: { content: JSON.stringify(signInToolResult(done)) },
        messageId: `sign-in-result:${done.id}`,
      },
    } as never);
    expect(resumed).toEqual({ replyText: "I am in." });
    expect(context.computer.fills[0]?.password).toBe(PASSWORD);
    const toolMessage = remote.requests[1]?.messages.find(
      (message) => message.role === "tool",
    );
    expect(String(toolMessage?.content)).toContain('"signedIn":true');
    expectNoCredential(
      everything(persisted, remote.requests, context.trail.rows, [
        ...context.store.requests.values(),
      ]),
    );
  });
});

/**
 * A request claimed for typing leaves `filling` on every path. Left there, every later attempt is
 * answered "already being entered" and the waiting turn never resumes.
 */
describe("a sign-in that is being entered", () => {
  test("is refused before anything is typed when saving is off and the person asked to save", async () => {
    const context = setup({ manager: false });
    const request = await context.service.request({
      ownerUserId: "owner",
      botId: "bot",
      site: "example.com",
      actor,
    });
    await expect(
      context.service.submit("owner", request.id, actor, {
        username: USERNAME,
        password: PASSWORD,
        save: true,
      }),
    ).rejects.toThrow(/turned off/);
    expect(context.computer.fills).toHaveLength(0);
    expect((await context.service.get("owner", request.id)).status).toBe(
      "pending",
    );
  });

  test("ends signed in, and the Bot is told, when saving the login fails after the site accepted it", async () => {
    const context = setup();
    context.store.saveLogin = async () => {
      throw new Error("the vault is unavailable");
    };
    const request = await context.service.request({
      ownerUserId: "owner",
      botId: "bot",
      site: "example.com",
      actor,
    });
    await expect(
      context.service.submit("owner", request.id, actor, {
        username: USERNAME,
        password: PASSWORD,
        save: true,
      }),
    ).rejects.toThrow(/could not be saved/);
    expect((await context.service.get("owner", request.id)).status).toBe(
      "signed_in",
    );
    expect(context.resolved.map((row) => row.status)).toEqual(["signed_in"]);
    expectNoCredential(everything(context.trail.rows, context.resolved));
  });

  test("an attempt that never finished opens again once its lease has passed", async () => {
    const context = setup();
    const request = await context.service.request({
      ownerUserId: "owner",
      botId: "bot",
      site: "example.com",
      actor,
    });
    // What a server that died mid-fill leaves behind.
    await context.store.transition("owner", request.id, ["pending"], {
      status: "filling",
      fillingUntil: new Date(Date.now() - 1_000),
    });
    expect((await context.service.get("owner", request.id)).status).toBe(
      "pending",
    );
    const done = await context.service.submit("owner", request.id, actor, {
      username: USERNAME,
      password: PASSWORD,
    });
    expect(done.status).toBe("signed_in");
  });
});
