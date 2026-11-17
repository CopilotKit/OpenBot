/**
 * The update panel in OpenBot's own page. OpenBot Desktop reads its update feed itself and the
 * page asks it, through the IPC Tauri injects into the Desktop window (`window.__TAURI_INTERNALS__`,
 * read by `desktopShell`). These tests stand in for exactly that object, answering the way the
 * shell's `openbot-desktop` plugin answers (desktop/src-tauri/src/desktop_page.rs), and nothing
 * else: the component, its query and its mutations are the real ones.
 *
 * Off Desktop (a self-hosted OpenBot in any browser) there is no such object, and the panel must
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
import { environmentManager, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { UpdatePanel } from "@/components/layout/update-panel";
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
let restoreFailure: string | null;
let installStarts: boolean;
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
    // The shell keeps the newest version minimized and offers it as a pill.
    if (args?.version === offer.version)
      offer = { ...offer, version: null, minimized: offer.version };
    return null;
  }
  if (command === "plugin:openbot-desktop|restore_update") {
    if (restoreFailure) throw restoreFailure;
    offer = { ...offer, version: offer.minimized ?? null, minimized: null };
    return null;
  }
  if (command === "plugin:openbot-desktop|clear_update_outcome") {
    offer = { ...offer, outcome: null };
    return null;
  }
  if (command === "plugin:openbot-desktop|restart") return null;
  if (command === "plugin:openbot-desktop|open_logs") return null;
  if (command === "plugin:openbot-desktop|install_update") {
    if (installFailure) throw installFailure;
    // The shell records the install only after the click, and the page polls for it.
    if (installStarts)
      offer = {
        ...offer,
        installing: { downloaded: 0, total: 100, restarting: false },
      };
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

let wasServer = true;
beforeAll(() => {
  GlobalRegistrator.register({ url: "http://127.0.0.1:3010/" });
  wasServer = environmentManager.isServer();
  // TanStack Query read `window` before it was registered above and took this for a server, where
  // it never polls. The page polls the shell, so say it is a browser.
  environmentManager.setIsServer(() => false);
});
beforeEach(() => {
  calls = [];
  fetches = [];
  refuseOffer = null;
  installFailure = null;
  restoreFailure = null;
  installStarts = false;
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
  environmentManager.setIsServer(() => wasServer);
  await GlobalRegistrator.unregister();
});

const panel = { name: "OpenBot update" } as const;

function show() {
  return render(
    <QueryClientProvider client={queryClient}>
      <UpdatePanel />
    </QueryClientProvider>,
  );
}

const commands = () => calls.map((call) => call.command.split("|")[1]);

test("a self-hosted OpenBot, in a browser with no Desktop around it, draws nothing and asks nothing", async () => {
  const view = show();
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(view.queryByRole("complementary", panel)).toBeNull();
  expect(calls).toEqual([]);
  expect(fetches).toEqual([]);
});

test("a newer version is offered with Update and restart, and a click installs it", async () => {
  inDesktop();
  offer = { ...offer, version: "1.0.4" };
  const view = show();
  const box = await view.findByRole("complementary", panel);
  expect(box.textContent).toContain("OpenBot 1.0.4 is available.");
  fireEvent.click(view.getByRole("button", { name: "Update and restart" }));
  await waitFor(() => expect(commands()).toContain("install_update"));
  // The page asked the shell; it reached nothing on the network.
  expect(fetches).toEqual([]);
});

test("the panel says what the update leaves alone, in available, downloading and ready only", async () => {
  inDesktop();
  const view = show();
  const box = await view.findByRole("complementary", panel);
  expect(box.textContent).toContain("Your Bots and data stay as they are.");
  offer = { ...offer, ready: { state: "preparing", done: 1, total: 10 } };
  await queryClient.invalidateQueries({ queryKey: desktopKeys.appUpdate });
  await waitFor(() =>
    expect(box.textContent).toContain("You can keep working."),
  );
  offer = { ...offer, ready: { state: "ready" } };
  await queryClient.invalidateQueries({ queryKey: desktopKeys.appUpdate });
  await waitFor(() =>
    expect(box.textContent).toContain("OpenBot restarts to finish the update."),
  );
});

test("restarting, updated and failed say nothing of what is left alone", async () => {
  inDesktop();
  const lines = [
    "Your Bots and data stay as they are.",
    "You can keep working.",
    "OpenBot restarts to finish the update.",
  ];
  const states: DesktopAppUpdate[] = [
    {
      version: "0.3.2",
      current: "0.3.1",
      installing: { downloaded: 1, total: 2, restarting: false },
    },
    {
      version: null,
      current: "0.3.2",
      installing: null,
      outcome: {
        version: "0.3.2",
        release: "ok",
        backEnd: "ok",
        failedStep: null,
      },
    },
    {
      version: null,
      current: "0.3.1",
      installing: null,
      outcome: {
        version: "0.3.2",
        release: "failed",
        backEnd: "ok",
        failedStep: null,
      },
    },
  ];
  for (const next of states) {
    offer = next;
    const view = show();
    const box = await view.findByRole("complementary", panel);
    for (const line of lines) expect(box.textContent).not.toContain(line);
    cleanup();
    queryClient.clear();
  }
});

test("it is fixed in the corner, so the page under it does not move", async () => {
  inDesktop();
  const view = show();
  const box = await view.findByRole("complementary", panel);
  expect(box.className).toContain("fixed");
  expect(box.className).toContain("bottom-");
  expect(box.className).toContain("right-");
});

test("downloading shows how far, and ready says so, with Update and restart all along", async () => {
  inDesktop();
  offer = {
    ...offer,
    ready: { state: "preparing", done: 450, total: 1000 },
  };
  const view = show();
  const box = await view.findByRole("complementary", panel);
  expect(box.textContent).toContain("downloading in the background (45%)");
  expect(view.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
    "45",
  );
  expect(view.getByRole("button", { name: "Update and restart" })).toBeTruthy();
  offer = { ...offer, ready: { state: "ready" } };
  await queryClient.invalidateQueries({ queryKey: desktopKeys.appUpdate });
  await waitFor(() => expect(box.textContent).toContain("is ready to install"));
  expect(view.queryByRole("progressbar")).toBeNull();
});

test("the release notes open from What's new, as plain text", async () => {
  inDesktop();
  offer = { ...offer, notes: "Fixes the <b>sync</b> bug." };
  const view = show();
  await view.findByRole("complementary", panel);
  expect(view.getByText("What's new")).toBeTruthy();
  expect(view.getByText("Fixes the <b>sync</b> bug.")).toBeTruthy();
});

test("minimize tells the shell which version, and the panel becomes a pill", async () => {
  inDesktop();
  const view = show();
  fireEvent.click(await view.findByRole("button", { name: "Minimize" }));
  expect(
    await view.findByRole("button", { name: "Update 0.3.2" }),
  ).toBeTruthy();
  expect(calls).toContainEqual({
    command: "plugin:openbot-desktop|dismiss_update",
    args: { version: "0.3.2" },
  });
  expect(view.queryByRole("button", { name: "Update and restart" })).toBeNull();
});

test("a minimized version draws only the pill, and a click on it opens the panel again", async () => {
  inDesktop();
  offer = {
    version: null,
    minimized: "1.0.4",
    current: "1.0.3",
    installing: null,
  };
  const view = show();
  const pill = await view.findByRole("button", { name: "Update 1.0.4" });
  expect(view.queryByRole("button", { name: "Update and restart" })).toBeNull();
  fireEvent.click(pill);
  await waitFor(() => expect(commands()).toContain("restore_update"));
  expect(
    (await view.findByRole("button", { name: "Update and restart" }))
      .textContent,
  ).toBe("Update and restart");
});

test("nothing newer draws nothing", async () => {
  inDesktop();
  offer = { version: null, current: "0.3.1", installing: null };
  const view = show();
  await waitFor(() => expect(calls.length).toBe(1));
  expect(view.queryByRole("complementary", panel)).toBeNull();
  expect(view.queryByRole("button")).toBeNull();
});

test("restarting shows the install's progress and no buttons", async () => {
  inDesktop();
  offer = {
    ...offer,
    installing: { downloaded: 50, total: 200, restarting: false },
  };
  const view = show();
  const box = await view.findByRole("complementary", panel);
  expect(box.textContent).toContain("Downloading… 25%");
  expect(view.getByRole("progressbar")).toBeTruthy();
  expect(view.queryByRole("button")).toBeNull();
  offer = {
    ...offer,
    installing: { downloaded: 200, total: 200, restarting: true },
  };
  await queryClient.invalidateQueries({ queryKey: desktopKeys.appUpdate });
  await waitFor(() => expect(box.textContent).toContain("Restarting…"));
  expect(view.queryByRole("button")).toBeNull();
});

test("a finished update says so with its notes, and the close button clears it", async () => {
  inDesktop();
  offer = {
    version: null,
    current: "1.0.4",
    installing: null,
    notes: "Faster start.",
    outcome: {
      version: "1.0.4",
      release: "ok",
      backEnd: "ok",
      failedStep: null,
    },
  };
  const view = show();
  const box = await view.findByRole("complementary", panel);
  expect(box.textContent).toContain("Updated to OpenBot 1.0.4");
  expect(view.getByText("Faster start.")).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "Close" }));
  await waitFor(() => expect(commands()).toContain("clear_update_outcome"));
  await waitFor(() =>
    expect(view.queryByRole("complementary", panel)).toBeNull(),
  );
});

test("a failed update says so, and Try again restarts OpenBot", async () => {
  inDesktop();
  offer = {
    version: null,
    current: "1.0.3",
    installing: null,
    outcome: {
      version: "1.0.4",
      release: "ok",
      backEnd: "failed",
      failedStep: null,
    },
  };
  const view = show();
  const box = await view.findByRole("complementary", panel);
  expect(box.textContent).toContain("Couldn't finish updating");
  expect(box.textContent).toContain("Your data is kept.");
  fireEvent.click(view.getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(commands()).toContain("restart"));
  fireEvent.click(view.getByRole("button", { name: "Open log" }));
  await waitFor(() => expect(commands()).toContain("open_logs"));
  fireEvent.click(view.getByRole("button", { name: "Close" }));
  await waitFor(() => expect(commands()).toContain("clear_update_outcome"));
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

test("after a click on Update and restart, the panel moves to Restarting without a manual refetch", async () => {
  inDesktop();
  installStarts = true;
  const view = show();
  fireEvent.click(
    await view.findByRole("button", { name: "Update and restart" }),
  );
  await waitFor(() => expect(view.getByText("Downloading… 0%")).toBeTruthy(), {
    timeout: 3000,
  });
  expect(view.getByText("Restarting")).toBeTruthy();
  expect(view.queryByRole("button", { name: "Update and restart" })).toBeNull();
});

test("a pill that can't open the update says why", async () => {
  inDesktop();
  restoreFailure = "the update is gone";
  offer = {
    version: null,
    minimized: "1.0.4",
    current: "1.0.3",
    installing: null,
  };
  const view = show();
  fireEvent.click(await view.findByRole("button", { name: "Update 1.0.4" }));
  expect((await view.findByRole("alert")).textContent).toBe(
    "Couldn't show the update: the update is gone",
  );
  expect(view.getByRole("button", { name: "Update 1.0.4" })).toBeTruthy();
});

test("an older Desktop app without the command draws nothing, and is asked once", async () => {
  inDesktop();
  refuseOffer =
    "plugin openbot-desktop not allowed to run command update_offer";
  const view = show();
  await waitFor(() => expect(calls.length).toBe(1));
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(calls.length).toBe(1);
  expect(view.queryByRole("complementary", panel)).toBeNull();
});

/**
 * Nothing a Helm or Compose deployment runs knows the Desktop update feed: only OpenBot Desktop's
 * own shell reads it. A page or Compose file that named it would be a self-hosted OpenBot reaching
 * downloads.copilotkit.ai, which is never wanted.
 */
test("no code a self-hosted deployment runs names the Desktop update feed", () => {
  const root = join(import.meta.dir, "..", "..");
  const shipped = ["app/src", "shared", "docker-compose.yml"];
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
