import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryList, RememberFact } from "@/components/memory/memories";
import { answerBotsList } from "./bots-api";
import {
  MEMORY,
  memoryBody,
  memoryContract,
  page,
  problem,
  requestOf,
  served,
} from "./learning-api";
import { settleReactWork } from "./settle-react-work";

/** Memory: what the person's Bots know about them, and which Bot learned it. */

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

const memory = (overrides: Record<string, unknown>) =>
  memoryBody({
    id: "m1",
    content: "I prefer mornings.",
    provenance: "You told a Bot",
    updatedAt: "2026-10-09T10:00:00Z",
    ...overrides,
  });

const writes: { request: string; body: unknown }[] = [];
/** A refusal the server gives the next write, or none. */
let refuseWrite: string | null = null;
function serving() {
  writes.length = 0;
  refuseWrite = null;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = requestOf(input, init);
    if (request.method !== "GET") {
      writes.push({
        request: `${request.method} ${request.path}`,
        body: request.body,
      });
      if (refuseWrite) {
        const detail = refuseWrite;
        refuseWrite = null;
        return problem(400, detail, "VALIDATION_ERROR");
      }
      if (request.method === "POST" && request.path === MEMORY.memories)
        return served(
          memoryContract.CreateMemoryResponse,
          memory({ id: "m3", content: request.body?.content }),
          201,
        );
      return problem(404, "This memory could not be found.", "NOT_FOUND");
    }
    const bots = answerBotsList(input, init, {
      visible: [{ id: "expenses", name: "Expenses", mine: true }],
    });
    if (bots) return bots;
    if (request.path === MEMORY.memories)
      return page(memoryContract.ListMemoriesResponse, "memories", [
        memory({}),
        memory({
          id: "m2",
          content: "Receipts go to finance@.",
          formedBy: "bot",
          formedByBotId: "expenses",
          sourceApp: "Gmail",
          reviewState: "unreviewed",
        }),
      ]);
    return problem(404, "Not found.", "NOT_FOUND");
  }) as unknown as typeof fetch;
}

function draw(node: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>{node}</QueryClientProvider>,
  );
}

test("a memory a Bot formed names the Bot that formed it", async () => {
  serving();
  const view = draw(<MemoryList />);
  expect(await view.findByText(/Formed by Expenses/)).toBeTruthy();
});

test("remembering a fact saves it", async () => {
  serving();
  const view = draw(<RememberFact />);
  const user = userEvent.setup({ document });
  // The form lives in a dialog behind the page's action, not on the page.
  fireEvent.click(view.getByRole("button", { name: "Remember a fact" }));
  await user.type(
    await view.findByRole("textbox", {
      name: "Something you want your Bots to know",
    }),
    "I work from Lisbon.",
  );
  fireEvent.click(view.getByRole("button", { name: "Remember" }));
  await waitFor(() =>
    expect(writes).toContainEqual({
      request: `POST ${MEMORY.memories}`,
      body: { content: "I work from Lisbon." },
    }),
  );
});

test("each memory's switch is named for the memory it turns on or off", async () => {
  serving();
  const view = draw(<MemoryList />);
  expect(
    await view.findByRole("switch", {
      name: "Use this memory: I prefer mornings.",
    }),
  ).toBeTruthy();
  expect(
    view.getByRole("switch", {
      name: "Use this memory: Receipts go to finance@.",
    }),
  ).toBeTruthy();
});

// Seen live: the dialog's only line under its title was the memory's provenance, "You".
test("Edit memory says what the dialog is for", async () => {
  serving();
  const view = draw(<MemoryList />);
  await view.findByText("I prefer mornings.");
  fireEvent.click(view.getAllByRole("button", { name: "Edit" })[0]!);
  const dialog = await view.findByRole("dialog");
  expect(dialog.textContent).toContain("Change what your Bots remember.");
  expect(view.queryByText("You told a Bot", { exact: true })).toBeNull();
});

test("reopening Remember a fact after a failure starts clean", async () => {
  serving();
  refuseWrite = "Memory is full.";
  const view = draw(<RememberFact />);
  const user = userEvent.setup({ document });
  await user.click(view.getByRole("button", { name: "Remember a fact" }));
  await user.type(
    await view.findByRole("textbox", {
      name: "Something you want your Bots to know",
    }),
    "I work from Lisbon.",
  );
  await user.click(view.getByRole("button", { name: "Remember" }));
  expect((await view.findByRole("alert")).textContent).toBe("Memory is full.");
  await user.keyboard("{Escape}");
  await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
  await user.click(view.getByRole("button", { name: "Remember a fact" }));
  const field = (await view.findByRole("textbox", {
    name: "Something you want your Bots to know",
  })) as HTMLTextAreaElement;
  expect(field.value).toBe("");
  expect(view.queryByRole("alert")).toBeNull();
});
