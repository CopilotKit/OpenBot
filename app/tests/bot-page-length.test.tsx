import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { SuggestionsInbox } from "@/components/suggestions/proactive-panel";
import { settleReactWork } from "./settle-react-work";

/**
 * A Bot's page stays short enough to reach its settings: its suggestions show the newest few with
 * the rest folded away.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

test("the newest three suggestions show, and the rest open in place", async () => {
  global.fetch = (async (input: RequestInfo | URL) => {
    if (String(input) === "/api/proactive/suggestions")
      return Response.json({
        suggestions: Array.from({ length: 5 }, (_, index) => ({
          id: `s${index}`,
          agentId: "scout",
          title: `Suggestion ${index + 1}`,
          detail: "",
          sourceApp: null,
          sourceLink: null,
          createdAt: "2026-10-09T10:00:00Z",
        })),
      });
    return Response.json({ error: "unexpected" }, { status: 404 });
  }) as typeof fetch;
  const view = render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <SuggestionsInbox agentId="scout" />
    </QueryClientProvider>,
  );

  expect(await view.findByText("Suggestion 3")).toBeTruthy();
  expect(view.queryByText("Suggestion 4")).toBeNull();
  fireEvent.click(view.getByRole("button", { name: "Show 2 more" }));
  expect(view.getByText("Suggestion 5")).toBeTruthy();
  expect(view.queryByRole("button", { name: /more$/ })).toBeNull();
});
