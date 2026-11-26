import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RoutineBox } from "@/components/routines/routine-box";
import type { RoutineDraft, RoutineReading } from "@/lib/api/generated/model";
import { queryClient } from "@/query-client";
import { answerBotsList, problemResponse } from "./bots-api";
import { CONVERSATIONS_PATH } from "./conversations-api";
import { answerScheduleLists } from "./schedules-api";
import { settleReactWork } from "./settle-react-work";

/**
 * The Routines box: one sentence read by the server, written when the reading is ready, and said in
 * the line under the box otherwise.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(() => {
  cleanup();
  queryClient.clear();
  window.localStorage.clear();
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

const READ_PATH = "/api/v2/organizations/default/routines/read";
const CREATE_PATH = "/api/v2/organizations/default/routines";

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

type Request = [method: string, path: string, body: unknown];
let requests: Request[] = [];

function serving({
  bots = [{ id: "bot-1", name: "Atlas" }] as unknown[],
  checkIns = [] as unknown[],
  read = () => Response.json(ready(ACT_DRAFT)) as Response | Promise<Response>,
}: {
  bots?: unknown[];
  checkIns?: unknown[];
  read?: () => Response | Promise<Response>;
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
          { routine: { id: "r1", botId: "bot-1" } },
          { status: 201 },
        );
      return Response.json({ ok: true });
    }
    const list = answerBotsList(input, init, { visible: bots });
    if (list) return list;
    if (url === "/api/v2/organizations/default/check-ins?limit=100")
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

/** The reads of a sentence and the routines made, leaving out the conversations a make starts. */
const readsAndCreates = () =>
  requests
    .filter(([, path]) => !path.startsWith(CONVERSATIONS_PATH))
    .map(([method, path]) => `${method} ${path}`);

let router: { state: { location: { pathname: string; search: unknown } } };

function draw(examples?: readonly string[]) {
  router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({
      component: () => <RoutineBox examples={examples} />,
    }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

/** The sentence box, once the Bots and check-ins are in and it can be typed in. */
async function box(view: ReturnType<typeof draw>) {
  const textarea = (await view.findByLabelText(
    "What should it do, and when?",
  )) as HTMLTextAreaElement;
  await waitFor(() => expect(textarea.disabled).toBe(false));
  return textarea;
}

/** Sending waits for the Bot and the check-ins read, so a sentence is only sendable once they are in. */
async function sendable(view: ReturnType<typeof draw>) {
  await waitFor(() =>
    expect(
      (view.getByRole("button", { name: "Send" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
}

async function type(view: ReturnType<typeof draw>, sentence: string) {
  const textarea = await box(view);
  const user = userEvent.setup({ document });
  await user.type(textarea, sentence);
  await sendable(view);
  return { textarea, user };
}

test("a ready reading makes one routine and says so in the line", async () => {
  serving();
  const view = draw();
  const { textarea, user } = await type(view, "Brief me every weekday at 9");
  await user.keyboard("{Enter}");

  const line = await view.findByRole("status");
  expect(line.textContent).toContain(
    "Atlas took “Morning briefing” · Every weekday at 9:00 AM",
  );
  expect(readsAndCreates()).toEqual([
    `POST ${READ_PATH}`,
    `POST ${CREATE_PATH}`,
  ]);
  const open = view.getByRole("button", { name: "Open" });
  expect(open.getAttribute("href")).toBe("/routines/schedules/r1");
  expect(textarea.value).toBe("");
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
  const { textarea, user } = await type(view, "Brief me");
  await user.keyboard("{Enter}");

  await view.findByRole("button", { name: "Finish" });
  expect(readsAndCreates()).toEqual([`POST ${READ_PATH}`]);
  expect(textarea.value).toBe("Brief me");
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
  const { textarea } = await type(view, "Brief me");
  fireEvent.keyDown(textarea, { key: "Enter" });
  fireEvent.keyDown(textarea, { key: "Enter" });
  await waitFor(() => expect(readsAndCreates()).toHaveLength(1));
  fireEvent.keyDown(textarea, { key: "Enter" });
  await settleReactWork();
  expect(readsAndCreates()).toEqual([`POST ${READ_PATH}`]);

  release(Response.json({ outcome: "notRoutine" }));
  await waitFor(() =>
    expect(view.getByRole("status").textContent).toContain(
      "Couldn't read that as a routine.",
    ),
  );
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
  const { user } = await type(view, "Tell me about the inbox");
  await user.keyboard("{Enter}");

  const line = await view.findByRole("status");
  expect(line.textContent).toContain("Atlas already checks in on “Inbox”.");
  expect(readsAndCreates()).toEqual([`POST ${READ_PATH}`]);
});

test("a 503 with the server's sentence shows it and keeps the sentence", async () => {
  const said =
    "OpenBot needs a model key to read a sentence. Add one in the Vault, or use the form.";
  serving({ read: () => problemResponse(503, said) });
  const view = draw();
  const { textarea, user } = await type(view, "Brief me");
  await user.keyboard("{Enter}");

  const line = await view.findByRole("status");
  expect(line.textContent).toContain(said);
  // The line's own action, and the link beside the box.
  expect(view.getByRole("button", { name: "Use the form" })).toBeTruthy();
  expect(view.getByRole("link", { name: "Use the form" })).toBeTruthy();
  expect(textarea.value).toBe("Brief me");
});

test("pressing an example fills the box and reads nothing", async () => {
  serving();
  const view = draw(["Brief me every weekday at 9"]);
  const textarea = await box(view);
  const user = userEvent.setup({ document });
  await user.click(
    view.getByRole("button", { name: "Brief me every weekday at 9" }),
  );
  expect(textarea.value).toBe("Brief me every weekday at 9");
  expect(document.activeElement).toBe(textarea);
  await settleReactWork();
  expect(readsAndCreates()).toEqual([]);
});

test("with no Bots it says to make one first, and has no box", async () => {
  serving({ bots: [] });
  const view = draw();
  await view.findByText("Make a Bot first to give it routines.");
  expect(view.queryByLabelText("What should it do, and when?")).toBeNull();
});
