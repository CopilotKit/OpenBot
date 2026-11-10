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
import {
  recordHereMutationOptions,
  stopHereMutationOptions,
} from "@/lib/recorder/mutations";
import {
  RECORDINGS_POLL_MS,
  recorderKeys,
  recordingsQueryOptions,
} from "@/lib/recorder/queries";
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
/** Cursors whose request fails with a 500. */
const failing = new Set<string>();

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
  failing.clear();
  pages = {};
  global.fetch = Object.assign(
    async (path: Parameters<typeof fetch>[0]) => {
      const url = String(path);
      asked.push(url);
      const cursor = new URL(url, "http://x").searchParams.get("cursor") ?? "";
      if (failing.has(cursor))
        return Response.json({ error: "Server trouble" }, { status: 500 });
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
  // Never reads as a success: an outcome that never arrived says so.
  expect(view.getByText("No result")).toBeTruthy();
  expect(view.getByText("Not in the backend")).toBeTruthy();
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
    "No recordings yet. Each task you record shows up here.",
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
    "The backend isn't available, so your recordings can't be listed.",
  );
  expect(view.queryByText(/No recordings yet/)).toBeNull();
});

test("an unavailable backend says so instead of listing rows", async () => {
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
  await view.findByText(/Couldn't reach the backend/);
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
  await view.findByText(/Couldn't reach the backend/);
  expect(view.getByText("Refund an order")).toBeTruthy();
  expect(view.getByText("Show more")).toBeTruthy();
  pages.c2 = {
    recordings: [row({ id: "r2", title: "Close a ticket" })],
    nextCursor: null,
  };
  fireEvent.click(view.getByText("Show more"));
  await view.findByText("Close a ticket");
  expect(view.queryByText(/Couldn't reach the backend/)).toBeNull();
  expect(view.getByText("Refund an order")).toBeTruthy();
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

test("a failed Show more keeps the rows already loaded and Show more retries it", async () => {
  pages[""] = { recordings: [row({})], nextCursor: "c2" };
  failing.add("c2");
  const view = render(
    <QueryClientProvider client={queryClient}>
      <YourRecordings />
    </QueryClientProvider>,
  );
  await view.findByText("Refund an order");
  fireEvent.click(view.getByText("Show more"));
  await view.findByText(
    "Couldn't load more recordings. Try again.",
    {},
    { timeout: 4000 },
  );
  expect(view.getByText("Refund an order")).toBeTruthy();
  failing.clear();
  pages.c2 = {
    recordings: [row({ id: "r2", title: "Close a ticket" })],
    nextCursor: null,
  };
  fireEvent.click(view.getByText("Show more"));
  await view.findByText("Close a ticket");
  expect(
    view.queryByText("Couldn't load more recordings. Try again."),
  ).toBeNull();
  expect(view.getByText("Refund an order")).toBeTruthy();
});

test("a failed refresh keeps the rows on screen", async () => {
  pages[""] = { recordings: [row({})], nextCursor: null };
  const view = render(
    <QueryClientProvider client={queryClient}>
      <YourRecordings />
    </QueryClientProvider>,
  );
  await view.findByText("Refund an order");
  failing.add("");
  await queryClient.invalidateQueries({ queryKey: recorderKeys.recordings() });
  await view.findByText(
    "Couldn't refresh your recordings.",
    {},
    { timeout: 4000 },
  );
  expect(view.getByText("Refund an order")).toBeTruthy();
  expect(view.queryByRole("alert")).toBeNull();
});

test("a list that cannot be requested says so in an alert, with no rows", async () => {
  failing.add("");
  const view = render(
    <QueryClientProvider client={queryClient}>
      <YourRecordings />
    </QueryClientProvider>,
  );
  const alert = await view.findByRole("alert", {}, { timeout: 4000 });
  expect(alert.textContent).toBe("Server trouble");
  expect(view.queryByText(/No recordings yet/)).toBeNull();
});

test("the list asks again every few seconds while a recording is still sending, and not otherwise", () => {
  const interval = (ended: RecordingRow["ended"]) => {
    const refetchInterval = recordingsQueryOptions().refetchInterval as (
      query: unknown,
    ) => number | false;
    return refetchInterval({
      state: {
        data: { pages: [{ recordings: [row({ ended })], nextCursor: null }] },
      },
    });
  };
  expect(interval("sending")).toBe(RECORDINGS_POLL_MS);
  expect(interval("succeeded")).toBe(false);
});

test("the list asks again every few seconds while a stopped recording has not reached the backend yet", () => {
  // A recording the Recorder holds and sends later has no row until it lands (OpenBot Desktop, 2026-11-07).
  const refetchInterval = recordingsQueryOptions({ waiting: true })
    .refetchInterval as (query: unknown) => number | false;
  expect(
    refetchInterval({
      state: {
        data: { pages: [{ recordings: [row({})], nextCursor: null }] },
      },
    }),
  ).toBe(RECORDINGS_POLL_MS);
});

test("starting or stopping a recording from OpenBot refreshes the list", async () => {
  const invalidated: unknown[] = [];
  const invalidate = queryClient.invalidateQueries.bind(queryClient);
  queryClient.invalidateQueries = ((filters: {
    queryKey: readonly unknown[];
  }) => {
    invalidated.push(filters.queryKey);
    return invalidate(filters);
  }) as typeof queryClient.invalidateQueries;
  for (const options of [
    recordHereMutationOptions(queryClient),
    stopHereMutationOptions(queryClient),
  ]) {
    invalidated.length = 0;
    await options.onSuccess?.(
      undefined as never,
      undefined as never,
      undefined,
      undefined as never,
    );
    expect(invalidated).toContainEqual(recorderKeys.recordings());
  }
  queryClient.invalidateQueries = invalidate;
});
