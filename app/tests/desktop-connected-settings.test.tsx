/**
 * OpenBot Desktop can show an OpenBot that runs on this computer, or one it is connected to at an address. Connected,
 * nothing of OpenBot runs here, so Settings → Computer says where the app is connected and offers the two ways out
 * (sign out, or go back to OpenBot on this computer) in place of the services, memory and install folder of a local
 * OpenBot. The app's own version, updates and log folder stay, since those are about the app.
 *
 * The page holds no sign-in of its own there: the desktop app keeps it. So signing out, from Settings or from the
 * account menu, is asked of the desktop app, and a sign-in that stopped working sends the person back to the desktop
 * app's setup, never to the web sign-in screen.
 *
 * A desktop app from before it could connect refuses the question, and is read as OpenBot on this computer.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { ComponentType } from "react";
import { signOutMutationOptions } from "@/lib/auth/mutations";
import { deploymentKeys } from "@/lib/deployment/queries";
import type { DesktopStatus } from "@/lib/desktop/queries";
import { Route as AuthedRoute } from "@/routes/_authed";
import { Route as ComputerRoute } from "@/routes/_authed/settings/computer";
import { settleReactWork } from "./settle-react-work";

const ADDRESS = "https://openbot.northwind.example";

/** What a connected desktop app answers `status` with: the app's own facts and nothing of a local OpenBot. */
const CONNECTED_STATUS: DesktopStatus = {
  openbotRunning: false,
  openbotHeld: false,
  processes: [],
  containers: [],
  intelligenceStack: null,
  intelligenceContainers: [],
  engine: null,
  root: "",
  appPort: null,
  version: "1.1.0",
  build: "Built 2026-11-15 18:30 UTC from 795f619 on main",
  logFolder: "/Users/me/Library/Logs/ai.copilotkit.openbot.desktop",
};

const LOCAL_STATUS: DesktopStatus = {
  ...CONNECTED_STATUS,
  openbotRunning: true,
  openbotHeld: true,
  engine: "podman",
  root: "/Users/me/OpenBot",
  appPort: 3010,
};

type Shell = "connected" | "local" | "older";

/** Every command the page asked the desktop app, in order. */
let asked: string[] = [];
/** Every address the page asked the server. */
let fetched: string[] = [];
const originalFetch = globalThis.fetch;

function installShell(kind: Shell) {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    transformCallback: () => 0,
    invoke: async (command: string) => {
      const name = command.replace("plugin:openbot-desktop|", "");
      asked.push(name);
      if (name === "connection") {
        if (kind === "older") throw "command connection not found";
        return kind === "connected"
          ? { mode: "connected", address: ADDRESS }
          : { mode: "local", address: null };
      }
      if (name === "status")
        return kind === "connected" ? CONNECTED_STATUS : LOCAL_STATUS;
      if (name === "update_offer")
        return { version: null, current: "1.1.0", installing: null };
      if (name === "sign_out" || name === "change_connection") return null;
      throw `command ${command} not found`;
    },
  };
}

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://127.0.0.1:3010/" });
});
beforeEach(() => {
  asked = [];
  fetched = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      fetched.push(new URL(url, "http://127.0.0.1:3010").pathname);
      if (url.includes("/api/auth/sign-out"))
        return Response.json({ success: true });
      return Response.json({ error: "not served" }, { status: 401 });
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

function newQueryClient() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryDefaults(deploymentKeys.capabilities(), {
    staleTime: Number.POSITIVE_INFINITY,
  });
  queryClient.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    selfHostBanner: false,
    localEvaluation: false,
    edition: "team",
  });
  return queryClient;
}

function renderComputer(kind: Shell) {
  installShell(kind);
  const Page = ComputerRoute.options.component as ComponentType;
  const router = createRouter({
    routeTree: createRootRoute({ component: () => <Page /> }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={newQueryClient()}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

test("connected, Settings → Computer says where the app is connected and shows nothing of a local OpenBot", async () => {
  const view = renderComputer("connected");
  await view.findByRole("heading", { name: "Connection" });
  expect(view.getByText(ADDRESS)).toBeTruthy();
  expect(view.getByRole("button", { name: "Sign out" })).toBeTruthy();
  expect(view.getByRole("button", { name: "Use this computer" })).toBeTruthy();
  // The app itself: its version and its log folder stay.
  expect(await view.findByText("Version 1.1.0")).toBeTruthy();
  expect(view.getByRole("button", { name: "Open log folder" })).toBeTruthy();
  // Nothing OpenBot runs here: no services, no install folder, no engine.
  expect(view.queryByRole("heading", { name: "App" })).toBeNull();
  expect(view.queryByText("Software OpenBot runs on")).toBeNull();
  expect(view.queryByText("Installed in")).toBeNull();
  expect(view.queryByRole("button", { name: "Stop" })).toBeNull();
  expect(view.queryByRole("button", { name: "Restart" })).toBeNull();
  const header = view
    .getByRole("heading", { level: 1, name: "Computer" })
    .closest("header");
  expect(header?.textContent).toContain(
    "Connect the browsers you teach your Bots in, and see which OpenBot this app is connected to.",
  );
  expect(header?.textContent).not.toContain("runs on this computer");
});

test("with OpenBot on this computer, its services are as they were, and the way to connect to an OpenBot instead is offered", async () => {
  const view = renderComputer("local");
  await view.findByRole("heading", { name: "App" });
  expect(view.getByText("Installed in")).toBeTruthy();
  expect(view.queryByText("Connected to")).toBeNull();
  await view.findByRole("heading", { name: "Connection" });
  expect(view.getByText("OpenBot runs on this computer")).toBeTruthy();
});

test("Connect to an OpenBot asks first, saying OpenBot stops here and nothing is lost, then asks the desktop app", async () => {
  const view = renderComputer("local");
  fireEvent.click(
    await view.findByRole("button", { name: "Connect to an OpenBot" }),
  );
  const dialog = await view.findByRole("dialog");
  expect(dialog.textContent).toContain("Connect to an OpenBot instead?");
  expect(dialog.textContent).toContain("OpenBot stops on this computer");
  expect(dialog.textContent).toContain("Nothing on this computer is lost");
  expect(asked).not.toContain("change_connection");
  fireEvent.click(
    Array.from(dialog.querySelectorAll("button")).find(
      (button) => button.textContent === "Stop and open setup",
    ) as HTMLButtonElement,
  );
  await waitFor(() => expect(asked).toContain("change_connection"));
});

test("a desktop app from before it could connect is read as OpenBot on this computer", async () => {
  const view = renderComputer("older");
  await view.findByRole("heading", { name: "App" });
  expect(asked).toContain("connection");
  // It cannot connect, so it is not offered.
  expect(view.queryByRole("heading", { name: "Connection" })).toBeNull();
  expect(
    view.queryByRole("button", { name: "Connect to an OpenBot" }),
  ).toBeNull();
});

test("Sign out asks first, then asks the desktop app to sign out", async () => {
  const view = renderComputer("connected");
  fireEvent.click(await view.findByRole("button", { name: "Sign out" }));
  const dialog = await view.findByRole("dialog");
  expect(dialog.textContent).toContain(
    "Sign out of openbot.northwind.example?",
  );
  expect(asked).not.toContain("sign_out");
  fireEvent.click(
    Array.from(dialog.querySelectorAll("button")).find(
      (button) => button.textContent === "Sign out",
    ) as HTMLButtonElement,
  );
  await waitFor(() => expect(asked).toContain("sign_out"));
});

test("Use this computer asks first, saying nothing here is lost, then asks the desktop app to switch", async () => {
  const view = renderComputer("connected");
  fireEvent.click(
    await view.findByRole("button", { name: "Use this computer" }),
  );
  const dialog = await view.findByRole("dialog");
  expect(dialog.textContent).toContain("Use OpenBot on this computer instead?");
  expect(dialog.textContent).toContain("Nothing on this computer is lost");
  expect(asked).not.toContain("change_connection");
  fireEvent.click(
    Array.from(dialog.querySelectorAll("button")).find(
      (button) => button.textContent === "Switch to this computer",
    ) as HTMLButtonElement,
  );
  await waitFor(() => expect(asked).toContain("change_connection"));
  expect(asked).not.toContain("sign_out");
});

test("connected, the account menu's Sign out is the desktop app's, and the page is told it is leaving", async () => {
  installShell("connected");
  const queryClient = newQueryClient();
  const options = signOutMutationOptions(queryClient);
  const outcome = await options.mutationFn?.(undefined, {} as never);
  expect(asked).toContain("sign_out");
  expect(fetched).not.toContain("/api/auth/sign-out");
  expect(outcome).toEqual({ leaving: true });
});

test("with OpenBot on this computer or in a browser, Sign out is the web sign-out as before", async () => {
  for (const kind of ["local", "browser"] as const) {
    asked = [];
    fetched = [];
    if (kind === "local") installShell("local");
    const options = signOutMutationOptions(newQueryClient());
    const outcome = await options.mutationFn?.(undefined, {} as never);
    expect(asked).not.toContain("sign_out");
    expect(fetched).toContain("/api/auth/sign-out");
    expect(outcome).toEqual({ leaving: false });
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  }
});

test("connected, a sign-in that stopped working goes back to the desktop app's setup", async () => {
  installShell("connected");
  const guard = AuthedRoute.options.beforeLoad as (input: {
    context: { queryClient: QueryClient };
    location: { pathname: string };
  }) => Promise<void>;
  await guard({
    context: { queryClient: newQueryClient() },
    location: { pathname: "/" },
  }).catch(() => undefined);
  expect(fetched).toContain("/api/v2/organizations/default/people/me");
  expect(asked).toContain("sign_out");
});

test("in a browser, a visitor who is not signed in goes to the sign-in screen and no desktop app is asked", async () => {
  const guard = AuthedRoute.options.beforeLoad as (input: {
    context: { queryClient: QueryClient };
    location: { pathname: string };
  }) => Promise<void>;
  const thrown = await guard({
    context: { queryClient: newQueryClient() },
    location: { pathname: "/" },
  }).then(
    () => null,
    (error) => error,
  );
  expect(asked).toEqual([]);
  expect(JSON.stringify(thrown?.options ?? thrown)).toContain("/sign");
});
