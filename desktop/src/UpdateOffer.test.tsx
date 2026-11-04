import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";

type Progress =
  | { event: "Started"; data: { contentLength?: number } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished" };

type Found = {
  version: string;
  currentVersion: string;
  downloadAndInstall: (onEvent: (event: Progress) => void) => Promise<void>;
};

let found: Found | null = null;
let checkFailure: string | null = null;
let checks = 0;
let relaunches = 0;

mock.module("@tauri-apps/plugin-updater", () => ({
  check: async () => {
    checks += 1;
    if (checkFailure) throw new Error(checkFailure);
    return found;
  },
}));

mock.module("@tauri-apps/plugin-process", () => ({
  relaunch: async () => {
    relaunches += 1;
  },
}));

const { UpdateOffer } = await import("./UpdateOffer");

beforeAll(() =>
  GlobalRegistrator.register({
    settings: { navigation: { disableChildPageNavigation: true } },
  }),
);
afterEach(() => {
  found = null;
  checkFailure = null;
  checks = 0;
  relaunches = 0;
  cleanup();
});
afterAll(() => GlobalRegistrator.unregister());

function anUpdate(overrides: Partial<Found> = {}): Found {
  return {
    version: "0.3.0",
    currentVersion: "0.2.0",
    downloadAndInstall: async () => {},
    ...overrides,
  };
}

test("an unreachable update endpoint says nothing", async () => {
  checkFailure = "synthetic network refusal";
  const view = render(<UpdateOffer />);

  await waitFor(() => expect(checks).toBeGreaterThan(0));
  expect(view.container.textContent).toBe("");
  expect(view.queryByRole("alert")).toBeNull();
});

// Unsigned builds do not register the updater plugin at all, so `check()` is refused by Tauri
// rather than by the network. That build has nothing it could verify, so it offers nothing.
test("a build without the updater says nothing", async () => {
  checkFailure = "plugin updater not found";
  const view = render(<UpdateOffer />);

  await waitFor(() => expect(checks).toBeGreaterThan(0));
  expect(view.container.textContent).toBe("");
  expect(view.queryByRole("alert")).toBeNull();
});

test("no newer version says nothing", async () => {
  const view = render(<UpdateOffer />);

  await waitFor(() => expect(checks).toBeGreaterThan(0));
  expect(view.container.textContent).toBe("");
});

test("a newer version is offered with both versions named", async () => {
  found = anUpdate();
  const view = render(<UpdateOffer />);

  const heading = await view.findByRole("heading", {
    name: "OpenBot 0.3.0 is available",
  });
  expect(heading).toBeTruthy();
  expect(view.container.textContent).toContain("You are running 0.2.0");
});

test("installing downloads, reports progress, and restarts", async () => {
  const download: {
    report: ((event: Progress) => void) | null;
    release: (() => void) | null;
  } = { report: null, release: null };
  found = anUpdate({
    downloadAndInstall: async (onEvent) => {
      download.report = onEvent;
      await new Promise<void>((resolve) => {
        download.release = resolve;
      });
    },
  });
  const view = render(<UpdateOffer />);

  fireEvent.click(
    await view.findByRole("button", { name: "Update and restart" }),
  );
  await waitFor(() => expect(download.report).not.toBeNull());

  act(() => {
    download.report?.({ event: "Started", data: { contentLength: 200 } });
    download.report?.({ event: "Progress", data: { chunkLength: 50 } });
  });
  await waitFor(() =>
    expect(view.getByRole("button", { name: /Downloading/ }).textContent).toBe(
      "Downloading… 25%",
    ),
  );

  await act(async () => {
    download.release?.();
  });
  await waitFor(() => expect(relaunches).toBe(1));
});

test("an install that fails says so and does not restart", async () => {
  found = anUpdate({
    downloadAndInstall: async () => {
      throw new Error("synthetic signature refusal");
    },
  });
  const view = render(<UpdateOffer />);

  fireEvent.click(
    await view.findByRole("button", { name: "Update and restart" }),
  );

  const alert = await view.findByRole("alert");
  expect(alert.textContent).toContain("synthetic signature refusal");
  expect(relaunches).toBe(0);
});

test("declining removes the offer without installing", async () => {
  found = anUpdate();
  const view = render(<UpdateOffer />);

  fireEvent.click(await view.findByRole("button", { name: "Not now" }));

  await waitFor(() => expect(view.container.textContent).toBe(""));
  expect(relaunches).toBe(0);
});
