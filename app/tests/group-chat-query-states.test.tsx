import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { GroupChat } from "@/components/channels/group-chat";
import { groupKeys } from "@/lib/groups";
import { queryClient } from "@/query-client";
import { answerBotsList } from "./bots-api";
import { settleReactWork } from "./settle-react-work";

/**
 * A conversation with several Bots, before its read has answered and when it fails.
 *
 * It drew nothing while loading, and only the error's own words when the read failed, with no way
 * to try again short of reloading the page. A conversation with one Bot already drew its shape while
 * it loaded.
 */

const CHANNEL = "group-1";

/** How the group read answers right now. `hold` leaves it pending until `release` is called. */
let answer: "ok" | "fail" | "hold" = "ok";
let release: (() => void) | null = null;
let originalFetch: typeof fetch;

const group = () =>
  Response.json({
    bots: [
      { id: "errands", name: "Errand Helper" },
      { id: "budget", name: "Budget Buddy" },
    ],
    people: [
      { userId: "me", email: "me@example.test", name: null, creator: true },
    ],
    messages: [
      {
        id: "m-1",
        channelId: CHANNEL,
        ownerUserId: "me",
        agentId: null,
        text: "Which area first?",
        status: "completed",
        createdAt: new Date().toISOString(),
      },
    ],
  });

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === `/api/groups/${CHANNEL}`) {
      if (answer === "fail")
        return Response.json({ error: "Server error" }, { status: 500 });
      if (answer === "hold")
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      return group();
    }
    if (url.pathname === "/api/me")
      return Response.json({
        user: { id: "me", role: "user", email: "me@example.test" },
      });
    const bots = answerBotsList(url, init, { visible: [] });
    if (bots) return bots;
    if (url.pathname === "/api/approvals")
      return Response.json({
        enabled: true,
        requests: [],
        rules: [],
        teamRules: [],
        questions: [],
      });
    return Response.json({ error: "not served" }, { status: 404 });
  }) as typeof fetch;
});
beforeEach(() => {
  queryClient.clear();
  answer = "ok";
  release = null;
});
afterEach(() => {
  release?.();
  cleanup();
  queryClient.clear();
});
afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

const conversation = () =>
  render(
    <QueryClientProvider client={queryClient}>
      <GroupChat channelId={CHANNEL} />
    </QueryClientProvider>,
  );

test("while it loads, the conversation's shape is drawn and said once", async () => {
  answer = "hold";
  const view = conversation();
  const status = await view.findByRole("status", {
    name: "Loading this conversation",
  });
  // One announcement: the bars inside are hidden from a screen reader.
  expect(status.querySelector('[aria-hidden="true"]')).not.toBeNull();
  expect(view.queryByText(/Say something to/)).toBeNull();

  release?.();
  await view.findByText("Which area first?");
  expect(
    view.queryByRole("status", { name: "Loading this conversation" }),
  ).toBeNull();
});

test("a failed read says so and Retry loads it without a reload", async () => {
  answer = "fail";
  const view = conversation();
  const retry = await view.findByRole(
    "button",
    { name: "Retry" },
    { timeout: 3000 },
  );
  expect(
    view.getByText("Couldn't load this conversation. Try again."),
  ).toBeDefined();

  answer = "ok";
  fireEvent.click(retry);
  await view.findByText("Which area first?");
  expect(view.queryByRole("button", { name: "Retry" })).toBeNull();
});

test("a refetch that fails keeps the conversation on screen", async () => {
  const view = conversation();
  await view.findByText("Which area first?");

  answer = "fail";
  await queryClient
    .refetchQueries({ queryKey: groupKeys.detail(CHANNEL) })
    .catch(() => {});
  await waitFor(
    () =>
      expect(queryClient.getQueryState(groupKeys.detail(CHANNEL))?.status).toBe(
        "error",
      ),
    { timeout: 3000 },
  );

  expect(view.getByText("Which area first?")).toBeDefined();
  expect(view.queryByRole("button", { name: "Retry" })).toBeNull();
});
