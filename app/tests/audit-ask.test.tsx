import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { withFilters } from "@/components/audit/audit-filters";
import { AuditPage } from "@/components/manage/audit-page";
import { agentKeys } from "@/lib/agents/queries";
import { eventTypeFilter, REFUSED_EVENT_TYPES } from "@/lib/audit/outcome";
import { settleReactWork } from "./settle-react-work";

/**
 * Admin > Audit's Ask: a question becomes filter chips over the trail's own rows, with the
 * filters read back in a line, and a question the trail can't answer says so and sets nothing.
 *
 * The page, through its real queries, with `fetch` answering as the server does.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(() => cleanup());

const originalFetch = globalThis.fetch;
afterAll(async () => {
  globalThis.fetch = originalFetch;
  await settleReactWork();
  await GlobalRegistrator.unregister();
});

/** Two rows: a routine's Gmail send, and a person's click. */
const GMAIL = {
  id: "00000000-0000-4000-8000-000000000001",
  actorUserId: null,
  initiatorKind: "routine",
  initiatorId: "routine-digest",
  eventType: "mcp.call_succeeded",
  targetType: "mcp_tool",
  targetId: "composio-gmail/GMAIL_SEND_EMAIL",
  payload: {
    bot: "inbox",
    server: "composio-gmail",
    tool: "GMAIL_SEND_EMAIL",
    effect: "write",
  },
  createdAt: "2026-11-06T15:20:00.000Z",
};
const CLICK = {
  id: "00000000-0000-4000-8000-000000000002",
  actorUserId: "dana",
  initiatorKind: "person",
  initiatorId: null,
  eventType: "computer.action_allowed",
  targetType: "computer",
  targetId: "inbox",
  payload: {
    bot: "inbox",
    action: "computer_click",
    element: { name: "Archive", role: "button" },
  },
  createdAt: "2026-11-07T15:20:00.000Z",
};

/** What `POST /api/admin/audit-events/ask` answered on the real page for the same question. */
const ANSWERED = {
  answerable: "yes",
  unanswered: null,
  filters: {
    initiatorKind: ["routine"],
    app: ["gmail"],
    effect: "write",
    from: "2026-11-02T08:00:00.000Z",
    to: "2026-11-09T08:00:00.000Z",
  },
  reading:
    "Rows of Bot activity started by a routine, calling Gmail to change something, from 2 November through 8 November.",
  labels: { bots: {}, people: {}, apps: { gmail: "Gmail" }, rules: {} },
};
const UNANSWERABLE = {
  answerable: "no",
  unanswered:
    "The trail does not record email text. Tool arguments and message contents are left out on purpose.",
  filters: {},
  reading: null,
  labels: { bots: {}, people: {}, apps: {}, rules: {} },
};

function renderAsk(answers: unknown[]) {
  const listed: URL[] = [];
  const asked: unknown[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://127.0.0.1");
      if (url.pathname === "/api/admin/audit-events/ask") {
        asked.push(JSON.parse(String(init?.body)));
        return Response.json(answers.shift());
      }
      if (url.pathname === "/api/admin/audit-events") {
        listed.push(url);
        // The server's answer: the Gmail send matches the app filter, the click does not.
        const events = url.searchParams.get("app") ? [GMAIL] : [GMAIL, CLICK];
        return Response.json({ events });
      }
      return Response.json({ error: "not served" }, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  queryClient.setQueryData(agentKeys.list(false), [
    { id: "inbox", name: "Inbox triage" },
  ]);
  queryClient.setQueryData(agentKeys.list(true), []);
  const router = createRouter({
    routeTree: createRootRoute({ component: () => <AuditPage ask /> }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { view, listed, asked };
}

async function askQuestion(view: ReturnType<typeof render>, question: string) {
  const user = userEvent.setup({ document });
  const input = await view.findByLabelText("Ask about the audit trail");
  await user.clear(input);
  await user.type(input, question);
  await user.click(view.getByRole("button", { name: "Ask" }));
}

test("an answer becomes chips over the rows the server returns for them, read back in a line", async () => {
  const { view, listed, asked } = renderAsk([ANSWERED]);
  await view.findByText("2 events");

  await askQuestion(view, "Show me every Gmail write by a routine last week");

  await view.findByText("1 event");
  expect(asked[0]).toMatchObject({
    question: "Show me every Gmail write by a routine last week",
  });
  // The chips are the filters the rows were asked with, asked of the server, not the loaded rows.
  const chips = [...view.container.querySelectorAll("[data-audit-chip]")].map(
    (chip) => chip.textContent,
  );
  expect(chips).toEqual([
    "Started by: A routine",
    "App: Gmail",
    "Effect: Changes something",
    expect.stringMatching(/^After: /),
    expect.stringMatching(/^Before: /),
  ]);
  const last = listed.at(-1) as URL;
  expect(last.searchParams.get("app")).toBe("gmail");
  expect(last.searchParams.get("effect")).toBe("write");
  expect(last.searchParams.get("initiatorKind")).toBe("routine");
  expect(last.searchParams.get("from")).toBe("2026-11-02T08:00:00.000Z");
  expect(view.container.textContent).toContain(ANSWERED.reading);

  /*
   * FOUND ON THE REAL PAGE: the question box lived in the table's toolbar, which is drawn again
   * while new rows load, so asking emptied it and lost the answer's place. It stays.
   */
  expect(
    (view.getByLabelText("Ask about the audit trail") as HTMLInputElement)
      .value,
  ).toBe("Show me every Gmail write by a routine last week");

  // A chip taken off is asked of the server again, and the reading says it no longer describes them.
  fireEvent.click(view.getByRole("button", { name: "Remove App: Gmail" }));
  await view.findByText("2 events");
  expect(listed.at(-1)?.searchParams.get("app")).toBeNull();
  expect(listed.at(-1)?.searchParams.get("effect")).toBe("write");
  expect(view.container.textContent).toContain(
    "You've changed the filters since.",
  );
});

test("a question the trail can't answer says why and clears the chips, so no earlier filters pose as its rows", async () => {
  const { view } = renderAsk([ANSWERED, UNANSWERABLE]);
  await view.findByText("2 events");
  await askQuestion(view, "Show me every Gmail write by a routine last week");
  await view.findByText("1 event");

  await askQuestion(
    view,
    "What did the Inbox triage Bot write in the emails it sent yesterday?",
  );

  await view.findByText(/The trail can't answer this\./);
  expect(view.container.textContent).toContain(UNANSWERABLE.unanswered);
  await waitFor(() =>
    expect(view.container.querySelectorAll("[data-audit-chip]")).toHaveLength(
      0,
    ),
  );
  // Every event again, the unfiltered trail it was before the first question, with no reading over it.
  await view.findByText("2 events");
  expect(view.container.querySelector("[data-audit-reading]")).toBeNull();
});

test("chips narrow a saved view, and two sets with nothing in common ask for a value no row has", () => {
  const blocked = eventTypeFilter(REFUSED_EVENT_TYPES);
  const narrowed = new URLSearchParams(
    withFilters(blocked, {
      eventType: ["mcp.call_succeeded", "mcp.call_rejected"],
      app: ["gmail"],
    }),
  );
  expect(narrowed.get("eventType")).toBe("mcp.call_rejected");
  expect(narrowed.get("app")).toBe("gmail");

  expect(
    new URLSearchParams(
      withFilters(blocked, { eventType: ["mcp.call_succeeded"] }),
    ).get("eventType"),
  ).toBe("none");
  expect(
    new URLSearchParams(withFilters("?bot=inbox", { bot: "research" })).get(
      "bot",
    ),
  ).toBe("none");
  // No chips, no change: every saved view keeps the query it always had.
  expect(withFilters(blocked, {})).toBe(blocked);
  expect(withFilters("", {})).toBe("");
});
