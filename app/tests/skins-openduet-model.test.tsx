import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import { WaitingForYou } from "@/components/approvals/waiting";
import type { ApprovalInboxData } from "@/lib/approvals";
import {
  columnFor,
  conversationPath,
  isSkinScreen,
  tabForPath,
} from "@/skins/openduet/places";
import { waitingCount } from "@/skins/openduet/tasks-model";
import { settleReactWork } from "./settle-react-work";

/*
 * The rules OpenDuet's frame runs on. Which paths are tabs decides whether a screen has a tab bar
 * or a back disc; which column a path gets decides whether a page keeps OpenBot's width; and the
 * Tasks badge has to count exactly the rows OpenBot's own Needs input list draws.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

describe("which tab a path is", () => {
  test("every conversation OpenBot draws is Chat", () => {
    for (const path of [
      "/",
      "/channel/new",
      "/channel/c-1",
      "/group/g-1",
      "/group/new",
      "/bot",
      "/channel/c-1/",
    ])
      expect(tabForPath(path)).toBe("chat");
  });

  test("the skin's Tasks screen is Tasks", () => {
    expect(tabForPath("/s/tasks")).toBe("tasks");
    expect(isSkinScreen("/s/tasks")).toBe(true);
  });

  test("every other page opens over the app, with no tab", () => {
    for (const path of [
      "/bots",
      "/bots/b-1",
      "/bots/b-1/responsibilities",
      "/routines",
      "/capabilities/skills",
      "/capabilities/memory",
      "/connections",
      "/channel/c-1/extra",
    ]) {
      expect(tabForPath(path)).toBeNull();
      expect(isSkinScreen(path)).toBe(false);
    }
  });

  test("a conversation with several Bots opens as a group", () => {
    expect(conversationPath({ id: "c", agentIds: ["a"] })).toBe("/channel/c");
    expect(conversationPath({ id: "g", agentIds: ["a", "b"] })).toBe(
      "/group/g",
    );
  });
});

/*
 * Found in review: the 430px column held every page, so a Bot's page, Admin and the computer were
 * squeezed into a phone's width on a wide screen. Only Chat and Tasks are phone-shaped now.
 */
describe("how wide the column is", () => {
  test("Chat and Tasks are a phone's width", () => {
    expect(columnFor("/")).toBe("phone");
    expect(columnFor("/channel/c-1")).toBe("phone");
    expect(columnFor("/s/tasks")).toBe("phone");
  });

  test("a conversation with its computer or its Bot's details open has room for OpenBot's pane", () => {
    expect(columnFor("/channel/c-1", { watch: true })).toBe("pane");
    expect(columnFor("/channel/c-1", { settings: true })).toBe("pane");
    expect(columnFor("/bot", { watch: true })).toBe("pane");
  });

  test("every other page keeps OpenBot's own width", () => {
    for (const path of [
      "/bots",
      "/bots/b-1",
      "/bots/b-1/setup",
      "/routines",
      "/capabilities/skills",
      "/connections",
    ])
      expect(columnFor(path)).toBe("page");
  });
});

const request = (
  id: string,
  status: string,
): ApprovalInboxData["requests"][number] => ({
  id,
  status,
  createdAt: "2026-10-27T10:00:00.000Z",
  action: {
    botId: "b-1",
    toolRef: "computer_run_command",
    effect: "write",
    scope: "workspace",
    threadId: "t-1",
    args: { command: "echo hello" },
    target: null,
  },
});

/*
 * Found in review: Tasks drew approvals with its own copy of OpenBot's list. It now draws OpenBot's
 * `WaitingForYou`, and the only thing the skin still works out is the badge's number. This renders
 * OpenBot's list against the same inbox and holds the two to the same count, so a change to what
 * the list shows fails here rather than leaving a badge that disagrees with the screen.
 */
test("the Tasks badge counts exactly what OpenBot's Needs input list draws", async () => {
  const inbox: ApprovalInboxData = {
    enabled: true,
    requests: [
      request("waiting", "pending"),
      request("allowed", "allowed"),
      request("denied", "denied"),
    ],
    rules: [],
    teamRules: [],
    questions: [
      {
        id: "q-1",
        botId: "b-1",
        threadId: "t-1",
        question: "Which kiln?",
        createdAt: "2026-10-27T10:00:00.000Z",
      },
    ],
  };
  global.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input).split("?")[0];
    if (path === "/api/approvals") return Response.json(inbox);
    if (path === "/api/agents")
      return Response.json({ agents: [{ id: "b-1", name: "Ops Bot" }] });
    return Response.json({ error: "not served" }, { status: 404 });
  }) as typeof fetch;
  const view = render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <WaitingForYou />
    </QueryClientProvider>,
  );
  await waitFor(() =>
    expect(view.container.querySelectorAll('[data-slot="item"]').length).toBe(
      waitingCount(inbox),
    ),
  );
  expect(waitingCount(inbox)).toBe(2);
  expect(waitingCount(undefined)).toBe(0);
});
