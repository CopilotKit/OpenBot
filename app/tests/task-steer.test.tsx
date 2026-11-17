import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import type { ReactNode } from "react";
import { TaskSteer } from "@/components/tasks/task-steer";
import { settleReactWork } from "./settle-react-work";

/**
 * The line under a task's card in the conversation that started it: the latest thing the person
 * told the task directly in its thread. One line, replaced by the next steer, and none on a task
 * the person has told nothing or that no conversation started.
 *
 * The server is faked at the HTTP boundary only, answering in the API's shape.
 */

type Steer = { text: string; at: string } | null;
const base = {
  id: "task-1",
  botId: "general-assistant",
  conversationId: "channel_task",
  threadId: "thread_task",
  title: "Compare seed prices",
  why: null,
  origin: "delegated",
  suggestionId: null,
  sourceApp: null,
  sourceLink: null,
  originConversationId: "channel_main" as string | null,
  status: "working",
  failure: null,
  failedAt: null,
  next: null,
  resolvedAt: null,
  createdAt: "2026-11-14T22:00:00.000Z",
  updatedAt: "2026-11-14T22:00:00.000Z",
};
let task: typeof base & { steer?: Steer } = base;
const server = setupServer(
  http.get("*/api/v2/organizations/:organizationId/tasks/:id", () =>
    HttpResponse.json({ task }),
  ),
  http.all("*", () => new HttpResponse(null, { status: 404 })),
);

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://openbot.invalid/" });
  server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => cleanup());
afterAll(async () => {
  server.close();
  await settleReactWork();
  GlobalRegistrator.unregister();
});

function draw(children: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  );
  return { ...view, client };
}
const lines = (view: { container: HTMLElement }) =>
  view.container.querySelectorAll("[data-slot=task-steer]");
const justNow = () => new Date().toISOString();

test("a steer is one line under the card, in the person's words, and the next one replaces it", async () => {
  task = {
    ...base,
    steer: { text: "also check the Friday listings", at: justNow() },
  };
  const view = draw(<TaskSteer taskId="task-1" />);
  await view.findByText("also check the Friday listings");
  expect(lines(view)).toHaveLength(1);
  expect(lines(view)[0]?.textContent).toContain("You told it:");
  expect(view.container.querySelector("time")?.textContent).toBe("now");

  // They steer again: the task is read again and the same line says the newer thing.
  task = { ...base, steer: { text: "skip the basil", at: justNow() } };
  await view.client.invalidateQueries();
  await view.findByText("skip the basil");
  expect(lines(view)).toHaveLength(1);
  expect(view.queryByText("also check the Friday listings")).toBeNull();
});

test("nothing is drawn for a task the person has told nothing", async () => {
  for (const steer of [null, undefined]) {
    task = { ...base, ...(steer === null ? { steer } : {}) };
    const view = draw(<TaskSteer taskId="task-1" />);
    await waitFor(() =>
      expect(
        view.client.getQueryState(["tasks", "one", "task-1"])?.status,
      ).toBe("success"),
    );
    expect(lines(view)).toHaveLength(0);
    cleanup();
  }
});

test("nothing is drawn for a task no conversation started, such as a check-in's", async () => {
  task = {
    ...base,
    origin: "check_in",
    originConversationId: null,
    steer: { text: "also check the Friday listings", at: justNow() },
  };
  const view = draw(<TaskSteer taskId="task-1" />);
  await waitFor(() =>
    expect(view.client.getQueryState(["tasks", "one", "task-1"])?.status).toBe(
      "success",
    ),
  );
  expect(lines(view)).toHaveLength(0);
});
