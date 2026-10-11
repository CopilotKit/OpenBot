import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { NativeDevices, RecentDeliveries } from "@/components/settings/devices";
import { settleReactWork } from "./settle-react-work";

/** Settings → Notifications: the person's phones, and what was recently sent to them. */

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

const requests: string[] = [];
function serving() {
  requests.length = 0;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(`${init?.method ?? "GET"} ${String(input)}`);
    return Response.json({
      bindings: [],
      devices: [{ id: "d1", platform: "ios", enabled: true }],
      deliveries: [
        {
          id: "x",
          transport: "push",
          kind: "question",
          state: "sent",
          error: null,
          createdAt: "2026-10-09T10:00:00Z",
        },
      ],
      available: { slack: false, teams: false, sms: false, push: true },
    });
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

test("a registered phone is listed and can be removed", async () => {
  serving();
  const view = draw(<NativeDevices />);
  expect(await view.findByText("iOS")).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "Remove" }));
  await waitFor(() =>
    expect(requests).toContain("DELETE /api/delivery/devices/d1"),
  );
});

test("recent deliveries are listed", async () => {
  serving();
  const view = draw(<RecentDeliveries />);
  expect(await view.findByText(/push · question/)).toBeTruthy();
});
