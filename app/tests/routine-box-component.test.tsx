import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RoutineBox } from "@/components/routines/routine-box";
import { viewerTimeZone } from "@/components/routines/routine-page";
import type { AgentProfile } from "@/lib/agents/queries";
import type { RoutineDraft, RoutineReading } from "@/lib/api/generated/model";
import { queryClient } from "@/query-client";
import { problemResponse } from "./bots-api";
import { CONVERSATIONS_PATH, problem, ROUTE_PATH } from "./conversations-api";
import { answerScheduleLists } from "./schedules-api";
import { settleReactWork } from "./settle-react-work";

/**
 * The Routines box: Home's message box with only its `@` menu. A sentence that names a Bot with `@`
 * is read for that Bot; one that names nobody is routed first, as Home routes it. The reading is
 * written when it is ready, and said in the line under the box otherwise.
 */

let originalRect: typeof Range.prototype.getBoundingClientRect;
beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  // The `@` menu opens at the caret, and prompt-area draws none for a range with no box.
  originalRect = Range.prototype.getBoundingClientRect;
  Range.prototype.getBoundingClientRect = () => new DOMRect(8, 8, 1, 16);
});
afterEach(() => {
  cleanup();
  queryClient.clear();
});
afterAll(async () => {
  await settleReactWork();
  Range.prototype.getBoundingClientRect = originalRect;
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

const READ_PATH = "/api/v2/organizations/default/routines/read";
const CREATE_PATH = "/api/v2/organizations/default/routines";
const CHECK_INS_PATH = "/api/v2/organizations/default/check-ins";

function bot(id: string, name: string): AgentProfile {
  return {
    id,
    name,
    avatarSeed: id,
    assignedToMe: false,
    runsOnOpenBotModel: false,
    keyFromOpenBot: false,
    builtIn: false,
    canManage: true,
    endpoint: null,
    hasAuth: false,
    hasCallbackToken: false,
    isolated: false,
    isolationActive: false,
    isolationOffReason: null,
    hidden: false,
    pinned: false,
    mine: true,
    roleDescription: "Role",
    systemOwned: false,
    title: "Title",
    visibility: "private",
  };
}

const ATLAS = bot("bot-1", "Atlas");
const SCOUT = bot("bot-2", "Scout");
const BOTS = [ATLAS, SCOUT];

const ACT_DRAFT: RoutineDraft = {
  instruction: "Send me a briefing",
  title: "Morning briefing",
  does: "act",
  starts: "schedule",
  cron: "0 9 * * 1-5",
  timezone: "UTC",
  doneWhen: "",
  conversationId: null,
  intervalMinutes: null,
};

const TELL_DRAFT: RoutineDraft = {
  instruction: "Tell me about the inbox",
  title: "Inbox",
  does: "tell",
  starts: "unsaid",
  cron: null,
  timezone: "UTC",
  doneWhen: "",
  conversationId: null,
  intervalMinutes: 240,
};

const ready = (draft: RoutineDraft): RoutineReading => ({
  outcome: "ready",
  draft,
});

/** The API's refusal when a sentence names a Bot more than one Bot answers to. */
const AMBIGUOUS =
  "More than one Bot has that name. Data Analyst, Risk Analyst. Choose one with @.";

type Request = [method: string, path: string, body: unknown];
let requests: Request[] = [];

function serving({
  checkIns = [] as unknown[],
  read = () => Response.json(ready(ACT_DRAFT)) as Response | Promise<Response>,
  route = () =>
    Response.json({
      botId: SCOUT.id,
      name: SCOUT.name,
      reason: "It reads your inbox.",
      fallback: false,
      viaMention: false,
    }) as Response,
}: {
  checkIns?: unknown[];
  read?: () => Response | Promise<Response>;
  route?: () => Response;
} = {}) {
  requests = [];
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (method !== "GET") {
      requests.push([
        method,
        url,
        typeof init?.body === "string" ? JSON.parse(init.body) : null,
      ]);
      if (url === ROUTE_PATH) return route();
      if (url === READ_PATH) return read();
      // A new conversation for the routine, which the create makes first.
      if (url === CONVERSATIONS_PATH)
        return Response.json(
          {
            conversation: {
              id: "c-new",
              name: "Atlas",
              botIds: ["bot-1"],
              threadId: "thread-c-new",
              active: true,
              lastMessageAt: null,
            },
          },
          { status: 201 },
        );
      if (url === CREATE_PATH)
        return Response.json(
          {
            routine: {
              id: "r1",
              botId: "bot-1",
              schedule: "Weekdays at 09:00",
              timezone: viewerTimeZone(),
            },
          },
          { status: 201 },
        );
      if (url.startsWith(CHECK_INS_PATH) && method === "POST")
        return Response.json(
          { checkIn: { id: "ci-new", botId: "bot-2", intervalMinutes: 240 } },
          { status: 201 },
        );
      if (method === "DELETE") return new Response(null, { status: 204 });
      return Response.json({ ok: true });
    }
    if (url === `${CHECK_INS_PATH}?limit=100`)
      return Response.json({
        nextCursor: null,
        allowed: true,
        checkIns,
      });
    const schedules = answerScheduleLists(input, init);
    if (schedules) return schedules;
    return Response.json({});
  }) as unknown as typeof fetch;
}

/**
 * The routing, the reads of a sentence and the writes, by address alone, leaving out the
 * conversation a make starts and names.
 */
const writes = () =>
  requests
    .map(([method, path]) => [method, path.split("?")[0]] as const)
    .filter(
      ([, path]) => path === ROUTE_PATH || !path.startsWith(CONVERSATIONS_PATH),
    )
    .map(([method, path]) => `${method} ${path}`);

/** What the box sent to be read. */
const readBodies = () =>
  requests.filter(([, path]) => path === READ_PATH).map(([, , body]) => body);

function draw({
  bots = BOTS as readonly AgentProfile[] | undefined,
  examples,
}: {
  bots?: readonly AgentProfile[];
  examples?: readonly string[];
} = {}) {
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({
      component: () => <RoutineBox bots={bots} examples={examples} />,
    }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

type View = ReturnType<typeof draw>;

/** The message box, once it can be typed in. */
async function box(view: View) {
  const editor = await view.findByRole("textbox", { name: "Message" });
  await waitFor(() =>
    expect(editor.getAttribute("contenteditable")).toBe("true"),
  );
  return editor;
}

/** Sending waits for the check-ins read, so a sentence is only sendable once it is in. */
async function sendable(view: View) {
  await waitFor(() =>
    expect(
      (view.getByRole("button", { name: "Send message" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
}

async function type(view: View, sentence: string) {
  const editor = await box(view);
  const user = userEvent.setup({ document });
  await user.type(editor, sentence);
  await sendable(view);
  return { editor, user };
}

/** Name a Bot with `@` as a person does: type `@`, a few letters, and pick it from the menu. */
async function mention(view: View, name: string) {
  const editor = await box(view);
  const user = userEvent.setup({ document });
  await user.click(editor);
  await user.keyboard("@");
  await user.keyboard(name.slice(0, 3));
  await user.click(
    await view.findByRole("option", { hidden: true, name: new RegExp(name) }),
  );
  return { editor, user };
}

test("a sentence that names Atlas with @ is read for Atlas, without the name, and makes one routine", async () => {
  serving();
  const view = draw();
  const { editor, user } = await mention(view, "Atlas");
  await user.keyboard("brief me every weekday at 9");
  await sendable(view);
  await user.keyboard("{Enter}");

  const line = await view.findByRole("status");
  expect(line.textContent).toContain(
    "Atlas took “Morning briefing” · Weekdays at 09:00",
  );
  // Nobody is routed: the sentence named its Bot.
  expect(writes()).toEqual([`POST ${READ_PATH}`, `POST ${CREATE_PATH}`]);
  expect(readBodies()).toEqual([
    expect.objectContaining({
      botId: "bot-1",
      sentence: "brief me every weekday at 9",
    }),
  ]);
  const open = view.getByRole("button", { name: "Open" });
  expect(open.getAttribute("href")).toBe("/routines/schedules/r1");
  expect(editor.textContent).toBe("");
});

test("a sentence that names nobody is routed once, then read for the Bot OpenBot picked", async () => {
  serving({
    read: () => Response.json(ready(TELL_DRAFT)),
  });
  const view = draw();
  const { user } = await type(view, "Tell me about the inbox");
  await user.keyboard("{Enter}");

  const line = await view.findByRole("status");
  expect(line.textContent).toContain("Scout took “Inbox”");
  expect(writes()).toContain(`POST ${CHECK_INS_PATH}`);
  const sent = writes();
  expect(sent[0]).toBe(`POST ${ROUTE_PATH}`);
  expect(sent[1]).toBe(`POST ${READ_PATH}`);
  expect(sent.filter((write) => write === `POST ${ROUTE_PATH}`)).toHaveLength(
    1,
  );
  expect(readBodies()).toEqual([
    expect.objectContaining({
      botId: "bot-2",
      sentence: "Tell me about the inbox",
    }),
  ]);
});

test("a routing refusal says its sentence, reads nothing, and keeps the sentence", async () => {
  serving({ route: () => problem(409, AMBIGUOUS, "BOT_NAME_AMBIGUOUS") });
  const view = draw();
  const { editor, user } = await type(view, "Ask the analyst every day at 9");
  await user.keyboard("{Enter}");

  const line = await view.findByRole("status");
  expect(line.textContent).toContain(AMBIGUOUS);
  expect(writes()).toEqual([`POST ${ROUTE_PATH}`]);
  await waitFor(() =>
    expect(editor.textContent).toBe("Ask the analyst every day at 9"),
  );
});

test("a reading that needs more makes no routine, shows Finish, and keeps the sentence", async () => {
  serving({
    read: () =>
      Response.json({
        outcome: "needsMore",
        missing: "time",
        draft: { ...ACT_DRAFT, starts: "unsaid", cron: null },
      }),
  });
  const view = draw();
  const { editor, user } = await mention(view, "Atlas");
  await user.keyboard("brief me");
  await sendable(view);
  await user.keyboard("{Enter}");

  await view.findByRole("button", { name: "Finish" });
  expect(writes()).toEqual([`POST ${READ_PATH}`]);
  await waitFor(() => expect(editor.textContent).toContain("brief me"));
  // The chip comes back with the words.
  expect(editor.textContent).toContain("Atlas");
});

test("Enter twice while the read is out sends one read", async () => {
  let release: (response: Response) => void = () => {};
  serving({
    read: () =>
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
  });
  const view = draw();
  const { user } = await mention(view, "Atlas");
  await user.keyboard("brief me");
  await sendable(view);
  await user.keyboard("{Enter}");
  await waitFor(() => expect(writes()).toHaveLength(1));
  await user.keyboard("again{Enter}");
  await settleReactWork();
  expect(writes()).toEqual([`POST ${READ_PATH}`]);

  release(Response.json({ outcome: "notRoutine" }));
  await waitFor(() =>
    expect(view.getByRole("status").textContent).toContain(
      "Couldn't read that as a routine.",
    ),
  );
});

test("two Enters before React draws again send one read", async () => {
  serving({ read: () => new Promise<Response>(() => {}) });
  const view = draw();
  const { editor } = await mention(view, "Atlas");
  await userEvent.setup({ document }).keyboard("brief me");
  await sendable(view);
  // One act around both: React draws nothing between them, so only a ref stops the second.
  await act(async () => {
    fireEvent.keyDown(editor, { key: "Enter" });
    fireEvent.keyDown(editor, { key: "Enter" });
  });
  await settleReactWork();
  expect(writes()).toEqual([`POST ${READ_PATH}`]);
});

test("a ready check-in the Bot already has makes no routine and says so", async () => {
  serving({
    read: () => Response.json(ready(TELL_DRAFT)),
    checkIns: [
      {
        id: "ci-1",
        botId: "bot-1",
        subject: "inbox",
        enabled: true,
      },
    ],
  });
  const view = draw();
  const { user } = await mention(view, "Atlas");
  await user.keyboard("tell me about the inbox");
  await sendable(view);
  await user.keyboard("{Enter}");

  const line = await view.findByRole("status");
  expect(line.textContent).toContain("Atlas already checks in on “Inbox”.");
  expect(writes()).toEqual([`POST ${READ_PATH}`]);
});

test("a 503 with the server's sentence shows it and keeps the sentence", async () => {
  const said =
    "OpenBot needs a model key to read a sentence. Add one in the Vault.";
  serving({ read: () => problemResponse(503, said) });
  const view = draw();
  const { editor, user } = await mention(view, "Atlas");
  await user.keyboard("brief me");
  await sendable(view);
  await user.keyboard("{Enter}");

  const line = await view.findByRole("status");
  expect(line.textContent).toContain(said);
  await waitFor(() => expect(editor.textContent).toContain("brief me"));
});

test("Undo deletes what was made and the line reads Removed.", async () => {
  serving();
  const view = draw();
  const { user } = await mention(view, "Atlas");
  await user.keyboard("brief me every weekday at 9");
  await sendable(view);
  await user.keyboard("{Enter}");

  await user.click(await view.findByRole("button", { name: "Undo" }));
  await waitFor(() =>
    expect(view.getByRole("status").textContent).toContain("Removed."),
  );
  expect(writes()).toContain(`DELETE ${CREATE_PATH}/r1`);
});

test("there is no form link, no Bot picker, and no menu but @", async () => {
  serving();
  const view = draw();
  await box(view);
  expect(view.queryByText("Use the form")).toBeNull();
  expect(view.queryByRole("combobox", { name: "Bot" })).toBeNull();
  // No attachments, no model picker, no routine clock, no voice call.
  expect(view.queryByRole("button", { name: "Attach a file" })).toBeNull();
  expect(view.queryByRole("button", { name: "Start voice call" })).toBeNull();
  expect(
    view.container.querySelector('[data-slot="composer-dictate"]'),
  ).toBeNull();
});

test("the empty box shows a sentence that names its Bot with @", async () => {
  serving();
  const view = draw();
  await box(view);
  expect(view.container.innerHTML).toContain(
    "@Assistant check my email every day at 9AM",
  );
  expect(view.container.innerHTML).not.toContain("Ask anything");
});

test("pressing an example fills the box and reads nothing", async () => {
  serving();
  const view = draw({ examples: ["Brief me every weekday at 9"] });
  await box(view);
  const user = userEvent.setup({ document });
  await user.click(
    view.getByRole("button", { name: "Brief me every weekday at 9" }),
  );
  await waitFor(() =>
    expect(view.getByRole("textbox", { name: "Message" }).textContent).toBe(
      "Brief me every weekday at 9",
    ),
  );
  await settleReactWork();
  expect(writes()).toEqual([]);
});

test("with no Bots it says to make one first, and has no box", async () => {
  serving();
  const view = draw({ bots: [] });
  await view.findByText("Make a Bot first to give it routines.");
  expect(view.getByRole("button", { name: "New Bot" })).toBeTruthy();
  expect(view.queryByRole("textbox", { name: "Message" })).toBeNull();
});

test("the send button spins while the sentence is read, and is an arrow again after", async () => {
  let release: (response: Response) => void = () => {};
  serving({
    read: () =>
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
  });
  const view = draw();
  const { user } = await mention(view, "Atlas");
  await user.keyboard("brief me");
  await sendable(view);
  expect(view.queryByTestId("composer-sending")).toBeNull();
  await user.keyboard("{Enter}");
  await view.findByTestId("composer-sending");

  release(Response.json({ outcome: "notRoutine" }));
  await waitFor(() =>
    expect(view.queryByTestId("composer-sending")).toBeNull(),
  );
});

test("the box is one line, Send beside the words, in a rounded rectangle", async () => {
  serving();
  const view = draw();
  await box(view);
  const frame = view.container.querySelector(
    '[data-slot="composer"]',
  ) as HTMLElement;
  expect(frame.className).toMatch(/\brounded-(xl|2xl)\b/);
  expect(frame.className).not.toContain("rounded-full");
  // The words and Send share one row, and nothing makes the empty box taller than a line.
  const input = view.container.querySelector(
    '[data-slot="composer-input"]',
  ) as HTMLElement;
  const send = view.getByRole("button", { name: "Send message" });
  const row = input.parentElement?.parentElement as HTMLElement;
  expect(row.className).toContain("flex");
  expect(row.contains(send)).toBe(true);
  // The editor opens one 24px line tall, not at its own 80px.
  expect(input.querySelector('[style*="min-height: 24px"]')).not.toBeNull();
  expect(input.querySelector('[style*="min-height: 80px"]')).toBeNull();
});
