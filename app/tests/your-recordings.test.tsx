import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type {
  RecordingRow,
  RecordingsPage,
} from "@openbot/shared/recorder-api";
import { environmentManager, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { YourRecordings } from "@/components/browser/your-recordings";
import { queryClient } from "@/query-client";

let wasServer = true;
beforeAll(() => {
  GlobalRegistrator.register();
  wasServer = environmentManager.isServer();
  environmentManager.setIsServer(() => false);
});
afterAll(() => {
  environmentManager.setIsServer(() => wasServer);
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
let pages: Record<string, RecordingsPage>;
const asked: string[] = [];

const row = (overrides: Partial<RecordingRow>): RecordingRow => ({
  id: "r1",
  title: "Refund an order",
  recordedAt: "2026-11-02T14:30:00.000Z",
  ended: "succeeded",
  reason: null,
  ...overrides,
});

beforeEach(() => {
  queryClient.clear();
  asked.length = 0;
  pages = {};
  global.fetch = Object.assign(
    async (path: Parameters<typeof fetch>[0]) => {
      const url = String(path);
      asked.push(url);
      const cursor = new URL(url, "http://x").searchParams.get("cursor") ?? "";
      return Response.json(
        pages[cursor] ?? { recordings: [], nextCursor: null },
      );
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  cleanup();
  global.fetch = originalFetch;
});

test("recordings show title, date and how each ended", async () => {
  pages[""] = {
    recordings: [
      row({}),
      row({ id: "r2", title: null, ended: "sending" }),
      row({ id: "r3", ended: "missing" }),
      row({ id: "r4", ended: "stopped", reason: "signed-out" }),
      row({ id: "r5", ended: "stopped", reason: "interrupted" }),
      row({ id: "r6", ended: "stopped", reason: "disconnected" }),
      row({ id: "r7", ended: "unknown" }),
    ],
    nextCursor: null,
  };
  const view = render(
    <QueryClientProvider client={queryClient}>
      <YourRecordings />
    </QueryClientProvider>,
  );
  await view.findAllByText("Refund an order");
  expect(view.getByText("Untitled recording")).toBeTruthy();
  expect(
    view.getAllByText(new Date("2026-11-02T14:30:00.000Z").toLocaleString())
      .length,
  ).toBe(7);
  expect(view.getByText("Still sending")).toBeTruthy();
  expect(view.getByText("Not in Intelligence")).toBeTruthy();
  expect(view.getByText("Stopped early: signed out")).toBeTruthy();
  expect(view.getByText("Stopped early: browser closed")).toBeTruthy();
  expect(view.getByText("Stopped early: disconnected")).toBeTruthy();
  expect(view.queryByText("Show more")).toBeNull();
});

test("no recordings shows one empty line", async () => {
  pages[""] = { recordings: [], nextCursor: null };
  const view = render(
    <QueryClientProvider client={queryClient}>
      <YourRecordings />
    </QueryClientProvider>,
  );
  await view.findByText(
    "No recordings yet. Record a task with the OpenBot Recorder to see it here.",
  );
});

test("an Intelligence without recordings says so in one line", async () => {
  pages[""] = {
    recordings: [],
    nextCursor: null,
    unavailable: "unavailable",
  };
  const view = render(
    <QueryClientProvider client={queryClient}>
      <YourRecordings />
    </QueryClientProvider>,
  );
  await view.findByText(
    "Intelligence isn't available, so your recordings can't be listed.",
  );
  expect(view.queryByText(/No recordings yet/)).toBeNull();
});

test("an unavailable Intelligence says so instead of listing rows", async () => {
  pages[""] = {
    recordings: [],
    nextCursor: null,
    unavailable: "unreachable",
  };
  const view = render(
    <QueryClientProvider client={queryClient}>
      <YourRecordings />
    </QueryClientProvider>,
  );
  await view.findByText(/Couldn't reach Intelligence/);
  expect(view.queryByText(/No recordings yet/)).toBeNull();
});

test("Show more loads the next page", async () => {
  pages[""] = { recordings: [row({})], nextCursor: "c2" };
  pages.c2 = {
    recordings: [row({ id: "r2", title: "Close a ticket" })],
    nextCursor: null,
  };
  const view = render(
    <QueryClientProvider client={queryClient}>
      <YourRecordings />
    </QueryClientProvider>,
  );
  await view.findByText("Refund an order");
  fireEvent.click(view.getByText("Show more"));
  await view.findByText("Close a ticket");
  expect(view.getByText("Refund an order")).toBeTruthy();
  await waitFor(() => expect(view.queryByText("Show more")).toBeNull());
  expect(asked).toContain("/api/recorder/recordings?cursor=c2");
});

test("a later page that cannot be reached says so below the rows, and Show more retries it", async () => {
  pages[""] = { recordings: [row({})], nextCursor: "c2" };
  pages.c2 = {
    recordings: [],
    nextCursor: "c2",
    unavailable: "unreachable",
  };
  const view = render(
    <QueryClientProvider client={queryClient}>
      <YourRecordings />
    </QueryClientProvider>,
  );
  await view.findByText("Refund an order");
  fireEvent.click(view.getByText("Show more"));
  await view.findByText(/Couldn't reach Intelligence/);
  expect(view.getByText("Refund an order")).toBeTruthy();
  expect(view.getByText("Show more")).toBeTruthy();
});

test("a first page with no rows still offers Show more when older ones exist", async () => {
  pages[""] = { recordings: [], nextCursor: "c2" };
  pages.c2 = {
    recordings: [row({ id: "r2", title: "Close a ticket" })],
    nextCursor: null,
  };
  const view = render(
    <QueryClientProvider client={queryClient}>
      <YourRecordings />
    </QueryClientProvider>,
  );
  await view.findByText("Show more");
  expect(view.queryByText(/No recordings yet/)).toBeNull();
  fireEvent.click(view.getByText("Show more"));
  await view.findByText("Close a ticket");
});
