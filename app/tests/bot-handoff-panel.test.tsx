import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import { HandoffPanel } from "@/components/agents/handoff-panel";
import type { BotHandoff } from "@/lib/api/generated/model";
import { answerBotsList, botOperationPath, handoffResponse } from "./bots-api";
import { settleReactWork } from "./settle-react-work";

/**
 * Which Bots one Bot may hand work to, on its page: read from the Bot's handoff at its address in
 * the API, which answers the object itself. Each other Bot is a switch, on where the grant is.
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

const ROSTER = [
  { id: "planner", name: "Planner", title: "Plans", avatarSeed: "p" },
  { id: "research", name: "Research", title: "Reads", avatarSeed: "r" },
  { id: "writer", name: "Writer", title: "Writes", avatarSeed: "w" },
];

function serving(handoff: Partial<BotHandoff>) {
  const requests: string[] = [];
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    requests.push(`${init?.method ?? "GET"} ${path}`);
    if (path === botOperationPath("planner", "handoff"))
      return handoffResponse(handoff);
    return (
      answerBotsList(input, init, { visible: ROSTER }) ??
      Response.json({ error: "not served" }, { status: 404 })
    );
  }) as unknown as typeof fetch;
  return requests;
}

function draw() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <HandoffPanel agentId="planner" />
    </QueryClientProvider>,
  );
}

const checked = (element: HTMLElement) =>
  element.getAttribute("aria-checked") === "true" ||
  element.hasAttribute("data-checked");

test("an admin sees a switch for each other Bot, on where this one may hand it work", async () => {
  const requests = serving({ canGrant: true, reachable: ["research"] });
  const view = draw();
  const research = await view.findByRole("switch", {
    name: "Let this Bot ask Research",
  });
  expect(checked(research)).toBe(true);
  expect(
    checked(view.getByRole("switch", { name: "Let this Bot ask Writer" })),
  ).toBe(false);
  // It is never offered itself.
  expect(
    view.queryByRole("switch", { name: "Let this Bot ask Planner" }),
  ).toBeNull();
  expect(view.getByText("1 of 2")).toBeTruthy();
  expect(requests).toContain(`GET ${botOperationPath("planner", "handoff")}`);
  expect(requests.filter((line) => line.includes("/api/agents"))).toEqual([]);
});

test("where handing work on is off, the panel says so and keeps the switches", async () => {
  serving({ enabled: false, canGrant: true, reachable: [] });
  const view = draw();
  expect(await view.findByText("Handoffs are off")).toBeTruthy();
  expect(
    view.getByRole("switch", { name: "Let this Bot ask Research" }),
  ).toBeTruthy();
});

test("someone who can't change it, with nothing granted, is shown nothing", async () => {
  const requests = serving({ canGrant: false, reachable: [] });
  const view = draw();
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(requests).toContain(`GET ${botOperationPath("planner", "handoff")}`);
  expect(view.container.textContent).toBe("");
});
