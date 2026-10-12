import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import { UpdateRoutingSection } from "@/components/settings/update-routing";
import { settleReactWork } from "./settle-react-work";

/**
 * Settings → Notifications only shows a channel as on when this deployment has set it up. A channel
 * that is not configured is off, disabled and says so, whatever the stored preference says.
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

function serving(available: {
  slack: boolean;
  teams: boolean;
  sms: boolean;
  push: boolean;
}) {
  global.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/api/bots/routing")) {
      return Response.json({
        routing: { progress: "all", decision: "all", question: "all" },
      });
    }
    if (url.endsWith("/api/delivery")) {
      return Response.json({
        bindings: [],
        devices: [],
        deliveries: [],
        available,
      });
    }
    return new Response(null, { status: 404 });
  }) as unknown as typeof fetch;
}

function draw() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <UpdateRoutingSection />
    </QueryClientProvider>,
  );
}

const checked = (element: HTMLElement) =>
  element.getAttribute("aria-checked") === "true" ||
  element.hasAttribute("data-checked");
const disabled = (element: HTMLElement) =>
  element.getAttribute("aria-disabled") === "true" ||
  element.hasAttribute("data-disabled") ||
  element.hasAttribute("disabled");

test("channels the deployment has not set up are off, disabled and say so", async () => {
  serving({ slack: false, teams: false, sms: false, push: true });
  const view = draw();
  const slack = await view.findByRole("switch", { name: "Progress by Slack" });
  expect(checked(slack)).toBe(false);
  expect(disabled(slack)).toBe(true);
  expect(view.getAllByText("Not set up").length).toBe(9);
  const push = view.getByRole("switch", { name: "Progress by Push" });
  expect(checked(push)).toBe(true);
  expect(disabled(push)).toBe(false);
});

test("a configured channel shows the person's preference", async () => {
  serving({ slack: true, teams: true, sms: true, push: true });
  const view = draw();
  const slack = await view.findByRole("switch", { name: "Progress by Slack" });
  expect(checked(slack)).toBe(true);
  expect(view.queryByText("Not set up")).toBeNull();
});
