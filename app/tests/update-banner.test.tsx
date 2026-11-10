/**
 * The update banner in OpenBot's own page. OpenBot Desktop reads its update feed itself and the
 * page asks it, through the IPC Tauri injects into the Desktop window (`window.__TAURI_INTERNALS__`,
 * read by `desktopShell`). These tests stand in for exactly that object, answering the way the
 * shell's `openbot-desktop` plugin answers (desktop/src-tauri/src/desktop_page.rs), and nothing
 * else: the component, its query and its mutations are the real ones.
 *
 * Off Desktop (a self-hosted OpenBot in any browser) there is no such object, and the banner must
 * neither draw nor ask anything, of the shell or of the network.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { UpdateBanner } from "@/components/layout/update-banner";
import { type DesktopAppUpdate, desktopKeys } from "@/lib/desktop/queries";
import { queryClient } from "@/query-client";

type Call = { command: string; args: unknown };

let offer: DesktopAppUpdate = {
  version: null,
  current: "0.3.1",
  installing: null,
};
let calls: Call[];
let fetches: string[];
let refuseOffer: string | null;
let installFailure: string | null;
let installRelease: (() => void) | null;
const originalFetch = globalThis.fetch;

/** The shell's plugin commands, as desktop_page.rs answers them. */
async function shellInvoke(command: string, args?: Record<string, unknown>) {
  calls.push({ command, args });
  if (command === "plugin:openbot-desktop|update_offer") {
    if (refuseOffer) throw refuseOffer;
    return offer;
  }
  if (command === "plugin:openbot-desktop|dismiss_update") {
    // The shell keeps the newest version closed and stops offering it.
    if (args?.version === offer.version) offer = { ...offer, version: null };
    return null;
  }
  if (command === "plugin:openbot-desktop|install_update") {
    if (installFailure) throw installFailure;
    // On success the app restarts and the call never answers.
    await new Promise<void>((resolve) => {
      installRelease = resolve;
    });
    return null;
  }
  throw `command ${command} not found`;
}

function inDesktop() {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: shellInvoke,
    transformCallback: () => 0,
  };
}

beforeAll(() => GlobalRegistrator.register({ url: "http://127.0.0.1:3010/" }));
beforeEach(() => {
  calls = [];
  fetches = [];
  refuseOffer = null;
  installFailure = null;
  installRelease = null;
  offer = { version: "0.3.2", current: "0.3.1", installing: null };
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      fetches.push(String(input));
      return Response.json({});
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  cleanup();
  installRelease?.();
  queryClient.clear();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 50));
  await GlobalRegistrator.unregister();
});

const banner = { name: "OpenBot update" } as const;

function show() {
  return render(
    <QueryClientProvider client={queryClient}>
      <UpdateBanner />
    </QueryClientProvider>,
  );
}

test("inside Desktop, a newer version is offered with Update and restart and a way to close it", async () => {
  inDesktop();
  const view = show();
  const bar = await view.findByRole("complementary", banner);
  expect(bar.textContent).toContain("OpenBot 0.3.2 is available.");
  expect(view.getByRole("button", { name: "Update and restart" })).toBeTruthy();
  expect(view.getByRole("button", { name: "Dismiss" })).toBeTruthy();
  // The page asked the shell; it reached nothing on the network.
  expect(calls.map((call) => call.command)).toEqual([
    "plugin:openbot-desktop|update_offer",
  ]);
  expect(fetches).toEqual([]);
});

test("while the new version downloads in the background it says how far, then that it is ready", async () => {
  inDesktop();
  offer = {
    version: "0.3.2",
    current: "0.3.1",
    installing: null,
    ready: { state: "preparing", done: 450, total: 1000 },
  };
  const view = show();
  const bar = await view.findByRole("complementary", banner);
  expect(bar.textContent).toContain(
    "OpenBot 0.3.2 is downloading in the background (45%).",
  );
  // It never holds the update back: Update and restart is there all along.
  expect(view.getByRole("button", { name: "Update and restart" })).toBeTruthy();
  offer = { ...offer, ready: { state: "ready" } };
  await queryClient.invalidateQueries({ queryKey: desktopKeys.appUpdate });
  await waitFor(() =>
    expect(bar.textContent).toContain(
      "OpenBot 0.3.2 is ready to install. It takes a few minutes.",
    ),
  );
  expect(fetches).toEqual([]);
});

test("nothing newer, or a version this person closed, draws nothing", async () => {
  inDesktop();
  offer = { version: null, current: "0.3.1", installing: null };
  const view = show();
  await waitFor(() => expect(calls.length).toBe(1));
  expect(view.queryByRole("complementary", banner)).toBeNull();
});

test("closing it tells the shell which version, and it stays closed", async () => {
  inDesktop();
  const view = show();
  fireEvent.click(await view.findByRole("button", { name: "Dismiss" }));
  await waitFor(() =>
    expect(view.queryByRole("complementary", banner)).toBeNull(),
  );
  expect(calls).toContainEqual({
    command: "plugin:openbot-desktop|dismiss_update",
    args: { version: "0.3.2" },
  });
});

test("a reload after closing it asks the shell again and still draws nothing, until a newer version", async () => {
  inDesktop();
  offer = { version: null, current: "0.3.1", installing: null };
  const reloaded = show();
  await waitFor(() => expect(calls.length).toBe(1));
  expect(reloaded.queryByRole("complementary", banner)).toBeNull();
  cleanup();
  queryClient.clear();

  offer = { version: "0.3.3", current: "0.3.1", installing: null };
  const later = show();
  expect(
    (await later.findByRole("complementary", banner)).textContent,
  ).toContain("OpenBot 0.3.3 is available.");
});

test("Update and restart asks the shell, then shows its progress in place of the buttons", async () => {
  inDesktop();
  const view = show();
  fireEvent.click(
    await view.findByRole("button", { name: "Update and restart" }),
  );
  expect((await view.findByRole("status")).textContent).toBe("Downloading…");
  expect(calls).toContainEqual({
    command: "plugin:openbot-desktop|install_update",
    args: undefined,
  });
  expect(view.queryByRole("button", { name: "Dismiss" })).toBeNull();

  offer = {
    ...offer,
    installing: { downloaded: 50, total: 200, restarting: false },
  };
  await queryClient.refetchQueries();
  await waitFor(() =>
    expect(view.getByRole("status").textContent).toBe("Downloading… 25%"),
  );
  offer = {
    ...offer,
    installing: { downloaded: 200, total: 200, restarting: true },
  };
  await queryClient.refetchQueries();
  await waitFor(() =>
    expect(view.getByRole("status").textContent).toBe("Restarting…"),
  );
});

test("an install that fails says why and offers it again", async () => {
  inDesktop();
  installFailure = "signature verification failed";
  const view = show();
  fireEvent.click(
    await view.findByRole("button", { name: "Update and restart" }),
  );
  expect((await view.findByRole("alert")).textContent).toBe(
    "Couldn't install the update: signature verification failed",
  );
  expect(view.getByRole("button", { name: "Update and restart" })).toBeTruthy();
});

test("an older Desktop app without the command draws nothing, and is asked once", async () => {
  inDesktop();
  refuseOffer =
    "plugin openbot-desktop not allowed to run command update_offer";
  const view = show();
  await waitFor(() => expect(calls.length).toBe(1));
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(calls.length).toBe(1);
  expect(view.queryByRole("complementary", banner)).toBeNull();
});

test("a self-hosted OpenBot, in a browser with no Desktop around it, draws nothing and asks nothing", async () => {
  const view = show();
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(view.queryByRole("complementary", banner)).toBeNull();
  expect(calls).toEqual([]);
  expect(fetches).toEqual([]);
});

/**
 * Nothing a Helm or Compose deployment runs knows the Desktop update feed: only OpenBot Desktop's
 * own shell reads it. A server, worker or page that named it would be a self-hosted OpenBot
 * reaching downloads.copilotkit.ai, which is never wanted.
 */
test("no code a self-hosted deployment runs names the Desktop update feed", () => {
  const root = join(import.meta.dir, "..", "..");
  const shipped = [
    "app/src",
    "server/src",
    "worker",
    "shared",
    "supervisor",
    "charts",
    "docker",
    "docker-compose.yml",
    "Dockerfile",
  ];
  const named: string[] = [];
  const visit = (path: string) => {
    const stat = statSync(path);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path)) {
        if (entry === "node_modules" || entry.startsWith(".")) continue;
        visit(join(path, entry));
      }
      return;
    }
    if (readFileSync(path, "utf8").includes("downloads.copilotkit.ai"))
      named.push(path.slice(root.length + 1));
  };
  for (const part of shipped) visit(join(root, part));
  expect(named).toEqual([]);
});
