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
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { ComputerViewPanel } from "@/components/computer/computer-panel";
import { getGetBotResponseMock } from "@/lib/api/generated/bots/bots.msw";
import { getGetWindowsComputerResponseMock } from "@/lib/api/generated/windows-computer/windows-computer.msw";

/**
 * A conversation's computer panel for a Bot set to work on a Windows computer (Bot.computer): the person's own, for
 * any Bot of theirs, not one Bot a Windows computer was set up for. Not connected yet, it says so and where to connect.
 */

/** Windows computers are on; whether this person has connected one is `enrolled`. */
let enrolled = true;

const server = setupServer(
  http.get("*/api/v2/organizations/:organizationId/bots/:botId", ({ params }) =>
    HttpResponse.json({
      bot: {
        ...getGetBotResponseMock().bot,
        id: String(params.botId),
        computer: "windows",
      },
    }),
  ),
  http.get("*/api/v2/organizations/:organizationId/windows-computer", () =>
    HttpResponse.json({
      ...getGetWindowsComputerResponseMock(),
      available: true,
      connected: enrolled,
      enrolled,
      control: { holder: "bot", since: "2026-11-27T09:00:00.000Z" },
    }),
  ),
  http.all("*", () => new HttpResponse(null, { status: 404 })),
);

let realWebSocket: typeof WebSocket;
beforeAll(() => {
  GlobalRegistrator.register({ url: "http://openbot.invalid/" });
  server.listen({ onUnhandledRequest: "error" });
  realWebSocket = globalThis.WebSocket;
  // The live screen's socket: opened and never answered, which is all these tests need of it.
  globalThis.WebSocket = class {
    readyState = 0;
    onopen = null;
    onclose = null;
    onerror = null;
    onmessage = null;
    send() {}
    close() {}
  } as unknown as typeof WebSocket;
});
afterEach(() => {
  cleanup();
  enrolled = true;
});
afterAll(() => {
  globalThis.WebSocket = realWebSocket;
  server.close();
  GlobalRegistrator.unregister();
});

function drawPanel(agentId: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const root = createRootRoute({
    component: () => <ComputerViewPanel agentId={agentId} />,
  });
  const page = createRoute({
    getParentRoute: () => root,
    path: "/windows-computer",
    component: () => null,
  });
  const router = createRouter({
    routeTree: root.addChildren([page]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

test("any Bot set to work on a Windows computer shows the person's own", async () => {
  for (const botId of ["general-assistant", "research-bot"]) {
    const view = drawPanel(botId);
    expect(
      await view.findByRole("button", {
        name: "Open your Windows computer's screen full size",
      }),
    ).toBeTruthy();
    expect(view.queryByText("No Windows computer yet")).toBeNull();
    cleanup();
  }
});

test("a person who has not connected a Windows computer is told so and where to connect one", async () => {
  enrolled = false;
  const view = drawPanel("general-assistant");
  expect(await view.findByText("No Windows computer yet")).toBeTruthy();
  const link = view.getByRole("link", {
    name: "Connect your Windows computer",
  });
  expect(link.getAttribute("href")).toBe("/windows-computer");
  expect(
    view.queryByRole("button", {
      name: "Open your Windows computer's screen full size",
    }),
  ).toBeNull();
});
