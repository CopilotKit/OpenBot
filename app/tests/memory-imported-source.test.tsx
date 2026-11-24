import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render } from "@testing-library/react";
import { MemoryList } from "@/components/memory/memories";
import { answerBotsList } from "./bots-api";
import {
  MEMORY,
  memoryBody,
  memoryContract,
  memorySourceBody,
  page,
  problem,
  requestOf,
} from "./learning-api";
import { settleReactWork } from "./settle-react-work";

/**
 * An imported memory on the Memory page says where it came from: the record, which Bot's memory
 * source read it in, and a link to that Bot's Memory page, where the source is turned off or removed.
 *
 * Reported from dogfooding: a page of memories read in from Typefully, each saying only
 * "Typefully: List social sets: … · Imported · needs review", and nothing about where they came from
 * or how to stop them.
 */

beforeAll(() =>
  GlobalRegistrator.register({ url: "http://openbot.invalid/memory" }),
);
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

function serving() {
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = requestOf(input, init);
    const bots = answerBotsList(input, init, {
      visible: [{ id: "research", name: "Research Bot", mine: true }],
    });
    if (bots) return bots;
    if (request.path === MEMORY.memories)
      return page(memoryContract.ListMemoriesResponse, "memories", [
        memoryBody({
          id: "m1",
          content:
            "Q4 launch plan\nMime type: application/vnd.google-apps.document",
          provenance: "Google Drive: List files: Q4 launch plan",
          sourceId: "s1",
          formedBy: "import",
          reviewState: "unreviewed",
          sourceApp: "Google Drive: List files",
          sourceLink: "https://docs.google.com/document/d/1Bxi/edit",
        }),
      ]);
    if (request.path === MEMORY.sources)
      return page(memoryContract.ListMemorySourcesResponse, "sources", [
        memorySourceBody({
          id: "s1",
          botId: "research",
          toolRef: "googledrive/GOOGLEDRIVE_LIST_FILES",
          title: "Google Drive: List files",
        }),
      ]);
    return problem(404, "Not found.", "NOT_FOUND");
  }) as unknown as typeof fetch;
}

/** Drawn under a router: the source's link goes to its Bot's Memory page. */
function draw() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const root = createRootRoute();
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/memory"] }),
    routeTree: root.addChildren([
      createRoute({
        getParentRoute: () => root,
        path: "/memory",
        component: () => <MemoryList />,
      }),
      createRoute({
        getParentRoute: () => root,
        path: "/bots/$agentId/memory",
        component: () => null,
      }),
    ]),
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

test("an imported memory names the Bot whose source read it in, and links to where that source is turned off", async () => {
  serving();
  const view = draw();
  const line = await view.findByText(
    /Read in by Research Bot from Google Drive: List files/,
  );
  expect(line.textContent).toBe(
    "Read in by Research Bot from Google Drive: List files · Open record · Turn off or remove this source",
  );
  // The record itself, said once: the source's name is on the line above, not repeated here.
  expect(
    view.getByText("Q4 launch plan · Imported · needs review"),
  ).toBeTruthy();
  const manage = view.getByRole("link", {
    name: "Turn off or remove this source",
  });
  expect(manage.getAttribute("href")).toBe("/bots/research/memory");
  expect(
    view.getByRole("link", { name: "Open record" }).getAttribute("href"),
  ).toBe("https://docs.google.com/document/d/1Bxi/edit");
});
