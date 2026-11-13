import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import {
  AllBotsActiveRow,
  PausedAllBanner,
} from "@/components/bots/paused-all";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/**
 * One switch pauses all of the person's Bots, read the way a Bot's own Active row reads: on means
 * they work. While it is off, a banner says so with Resume all.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(() => {
  cleanup();
  queryClient.clear();
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
let pausedAll = false;
const writes: unknown[] = [];
function serving() {
  writes.length = 0;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path === "/api/bots/pause-all" && init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as { paused: boolean };
      writes.push(body);
      pausedAll = body.paused;
      return Response.json({ pausedAll, stoppedTurns: 0 });
    }
    if (path === "/api/bots/attention")
      return Response.json({ bots: [], lastPingId: null, pausedAll });
    return Response.json({ error: "not served" }, { status: 404 });
  }) as unknown as typeof fetch;
}
afterAll(() => {
  global.fetch = originalFetch;
});

const draw = () =>
  render(
    <QueryClientProvider client={queryClient}>
      <PausedAllBanner />
      <AllBotsActiveRow />
    </QueryClientProvider>,
  );

test("All Bots active is on while they work, and turning it off pauses every Bot", async () => {
  pausedAll = false;
  serving();
  const view = draw();
  const toggle = await view.findByRole("switch", { name: "All Bots active" });
  await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
  expect(
    view.getByText(
      "Your Bots work on their routines, goals, hand-offs and follow-ups.",
    ),
  ).toBeTruthy();
  expect(view.queryByText("All your Bots are paused.")).toBeNull();
  fireEvent.click(toggle);
  await waitFor(() => expect(writes).toEqual([{ paused: true }]));
  expect(
    await view.findByText(
      "Paused. No Bot works for you until you turn this back on. You can still talk to one here.",
    ),
  ).toBeTruthy();
  expect(await view.findByText("All your Bots are paused.")).toBeTruthy();
});

test("Resume all on the banner turns every Bot back on", async () => {
  pausedAll = true;
  serving();
  const view = draw();
  fireEvent.click(await view.findByRole("button", { name: "Resume all" }));
  await waitFor(() => expect(writes).toEqual([{ paused: false }]));
  await waitFor(() =>
    expect(view.queryByText("All your Bots are paused.")).toBeNull(),
  );
});
