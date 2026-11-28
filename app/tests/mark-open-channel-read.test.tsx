import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import { act } from "react";
import { runEndedIn, useMarkOpenChannelRead } from "@/lib/channels/mark-read";
import {
  CONVERSATIONS_PATH,
  conversationPage,
  noContent,
  problem,
} from "./conversations-api";
import { settleReactWork } from "./settle-react-work";

/**
 * Having a conversation on screen marks it read — a group as much as a one-Bot conversation — so
 * neither its sidebar dot nor the Bots badge stays lit while the person is looking at the reply.
 * Only while it is in front of them: the server tells their phone about a reply still unread a while
 * after it ended, so one left open behind other windows stays unread until they come back.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
let focused = true;
afterEach(() => {
  global.fetch = originalFetch;
  focused = true;
});
beforeAll(() => {
  document.hasFocus = () => focused;
});

/** The person switches to another window, or back to OpenBot's. */
function focus(on: boolean) {
  focused = on;
  act(() => {
    window.dispatchEvent(new Event(on ? "focus" : "blur"));
  });
}

const row = (id: string, lastReadAt: string | null) => ({
  id,
  name: "Expense Review, General Assistant",
  agentIds: ["expenses", "general"],
  active: true,
  summary: null,
  lastMessage: "Done.",
  lastMessageAgentId: "expenses",
  lastMessageAt: "2026-10-09T10:00:00.000Z",
  createdAt: "2026-10-09T09:00:00.000Z",
  pinned: false,
  lastReadAt,
});

const writes: string[] = [];
function serving(readAt: string | null, rows = ["group-1"]) {
  writes.length = 0;
  // What the server holds: a mark-read moves it, as the real one does.
  let lastReadAt = readAt;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const path = String(input).split("?")[0];
    if (method !== "GET") {
      writes.push(`${method} ${String(input)}`);
      if (!path.endsWith("/mark-read")) return problem(404, "Not found.");
      lastReadAt = "2026-10-09T11:00:00.000Z";
      return noContent();
    }
    return path === CONVERSATIONS_PATH
      ? Response.json(conversationPage(rows.map((id) => row(id, lastReadAt))))
      : problem(404, "Not found.");
  }) as unknown as typeof fetch;
}

function Open({ channelId }: { channelId: string }) {
  useMarkOpenChannelRead(channelId);
  return null;
}

function draw(channelId = "group-1") {
  const client = new QueryClient({
    // Not read again on focus: the window coming back is what these tests switch.
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <Open channelId={channelId} />
    </QueryClientProvider>,
  );
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 100));

test("an open group with a Bot's reply the person has not seen is marked read, once", async () => {
  serving(null);
  draw();
  await waitFor(() =>
    expect(writes).toEqual([
      "POST /api/v2/organizations/default/conversations/group-1/mark-read",
    ]),
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(writes).toHaveLength(1);
});

test("an open group already read is marked once on open, since a run that ended unheard may be on screen", async () => {
  serving("2026-10-09T11:00:00.000Z");
  draw();
  await waitFor(() =>
    expect(writes).toEqual([
      "POST /api/v2/organizations/default/conversations/group-1/mark-read",
    ]),
  );
  await settled();
  expect(writes).toHaveLength(1);
});

test("a conversation opened in place of another, without remounting, is marked on open too", async () => {
  serving("2026-10-09T11:00:00.000Z", ["group-1", "group-2"]);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <Open channelId="group-1" />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(writes).toHaveLength(1));
  view.rerender(
    <QueryClientProvider client={client}>
      <Open channelId="group-2" />
    </QueryClientProvider>,
  );
  await waitFor(() =>
    expect(writes).toEqual([
      "POST /api/v2/organizations/default/conversations/group-1/mark-read",
      "POST /api/v2/organizations/default/conversations/group-2/mark-read",
    ]),
  );
});

test("an open conversation behind another window is left unread until the person comes back", async () => {
  serving(null);
  focused = false;
  draw();
  await settled();
  expect(writes).toEqual([]);
  focus(true);
  await waitFor(() =>
    expect(writes).toEqual([
      "POST /api/v2/organizations/default/conversations/group-1/mark-read",
    ]),
  );
});

test("a run that ends in a conversation the list does not hold is read when the person sees it", async () => {
  // A task's thread: kept off the list, so the roster never says anything new was said there.
  serving(null, []);
  draw("task-thread");
  // Opened, it is read: the person is looking at it.
  await waitFor(() => expect(writes).toHaveLength(1));
  writes.length = 0;
  act(() => runEndedIn("task-thread"));
  await waitFor(() =>
    expect(writes).toEqual([
      "POST /api/v2/organizations/default/conversations/task-thread/mark-read",
    ]),
  );
  await settled();
  expect(writes).toHaveLength(1);
});

test("a run that ends while the person is away is read once they come back, not before", async () => {
  // Already read, so only the run's end can mark it again: a failure, or a card with no words.
  serving("2026-10-09T11:00:00.000Z");
  draw();
  await waitFor(() => expect(writes).toHaveLength(1));
  writes.length = 0;
  focus(false);
  act(() => runEndedIn("group-1"));
  await settled();
  expect(writes).toEqual([]);
  focus(true);
  await waitFor(() =>
    expect(writes).toEqual([
      "POST /api/v2/organizations/default/conversations/group-1/mark-read",
    ]),
  );
});

test("a run that ends after focus left through a frame, which tells this window nothing, waits until the person is back", async () => {
  serving("2026-10-09T11:00:00.000Z");
  draw();
  await waitFor(() => expect(writes).toHaveLength(1));
  writes.length = 0;
  // Focus went into a frame, then to another app: no event reaches this window.
  focused = false;
  act(() => runEndedIn("group-1"));
  await settled();
  expect(writes).toEqual([]);
  // Back into the frame: no event either. The owed mark asks again on its own.
  focused = true;
  await waitFor(
    () =>
      expect(writes).toEqual([
        "POST /api/v2/organizations/default/conversations/group-1/mark-read",
      ]),
    { timeout: 3_000 },
  );
});
