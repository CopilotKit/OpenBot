/**
 * Settings → Computer is the personal edition's Computer, This computer and Browsers in one page. Desktop's tray Status
 * opens `/settings/this-computer` and the browser extension's popup opened `/settings/browsers`; both arrive here with a
 * hash naming their section, and the page scrolls to it, even when the section draws only after its data has loaded.
 *
 * The page says what it holds for the edition: the personal edition's one shared computer, with the warning that a
 * command one Bot runs can read another Bot's files; and in the team edition, what OpenBot runs on this computer only
 * where there is one to show, inside OpenBot Desktop.
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
import { cleanup, render, waitFor } from "@testing-library/react";
import type { ComponentType } from "react";
import type { DesktopStatus } from "@/lib/desktop/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import { Route as ComputerRoute } from "@/routes/_authed/settings/computer";
import { settleReactWork } from "./settle-react-work";

const STATUS: DesktopStatus = {
  openbotRunning: true,
  openbotHeld: true,
  processes: [],
  containers: [],
  intelligenceStack: null,
  intelligenceContainers: [],
  engine: "podman",
  root: "/Users/me/OpenBot",
  appPort: 3010,
  version: "1.0.1",
  build: "Built 2026-11-09 18:30 UTC from 795f619 on main",
} as DesktopStatus;

/** The Desktop status answers after this long, so its section draws well after the page itself. */
let statusDelay = 0;

async function shellInvoke(command: string) {
  if (command === "plugin:openbot-desktop|status") {
    await new Promise((resolve) => setTimeout(resolve, statusDelay));
    return STATUS;
  }
  if (command === "plugin:openbot-desktop|update_offer")
    return { version: null, current: "1.0.1", installing: null };
  throw `command ${command} not found`;
}

/** The id of every element the page scrolled into view, in order. */
const scrolledTo: string[] = [];
const originalFetch = globalThis.fetch;
let originalScroll: typeof Element.prototype.scrollIntoView;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://127.0.0.1:3010/" });
  originalScroll = Element.prototype.scrollIntoView;
});
beforeEach(() => {
  scrolledTo.length = 0;
  statusDelay = 0;
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolledTo.push(this.id);
  };
  globalThis.fetch = Object.assign(
    async () => Response.json({ error: "not served" }, { status: 404 }),
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  cleanup();
  Element.prototype.scrollIntoView = originalScroll;
  globalThis.fetch = originalFetch;
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

function renderPage(
  edition: "team" | "personal",
  options: { desktop?: boolean; at?: string } = {},
) {
  if (options.desktop)
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke: shellInvoke,
      transformCallback: () => 0,
    };
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryDefaults(deploymentKeys.capabilities(), {
    staleTime: Number.POSITIVE_INFINITY,
  });
  queryClient.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    selfHostBanner: false,
    localEvaluation: edition === "personal",
    edition,
  });
  const Page = ComputerRoute.options.component as ComponentType;
  const router = createRouter({
    routeTree: createRootRoute({ component: () => <Page /> }),
    history: createMemoryHistory({ initialEntries: [options.at ?? "/"] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

/** The page's description, under its title. */
async function descriptionOf(view: ReturnType<typeof render>) {
  const title = await view.findByRole("heading", { level: 1, name: "Computer" });
  return title.closest("header")?.textContent ?? "";
}

test("the extension's Browsers lands on the Browsers section, scrolled into view", async () => {
  const view = renderPage("team", { at: "/#browsers" });
  await descriptionOf(view);
  await waitFor(() => expect(scrolledTo).toContain("browsers"));
  expect(view.container.querySelector("#browsers")).not.toBeNull();
});

test("Desktop's Status lands on This computer, scrolled to once its section draws", async () => {
  statusDelay = 150;
  const view = renderPage("team", { desktop: true, at: "/#this-computer" });
  await descriptionOf(view);
  expect(view.container.querySelector("#this-computer")).toBeNull();
  await waitFor(() => expect(scrolledTo).toContain("this-computer"), {
    timeout: 2000,
  });
  expect(view.container.querySelector("#this-computer")).not.toBeNull();
});

test("with no section named, the page scrolls nowhere", async () => {
  const view = renderPage("team", { desktop: true });
  await view.findByRole("heading", { name: "App" });
  expect(scrolledTo).toEqual([]);
});

test("in the team edition, what OpenBot runs on this computer is promised only inside OpenBot Desktop", async () => {
  const browser = renderPage("team");
  expect(await descriptionOf(browser)).toContain(
    "Connect the browsers you teach your Bots in.",
  );
  expect(await descriptionOf(browser)).not.toContain("what OpenBot runs");
  cleanup();

  const desktop = renderPage("team", { desktop: true });
  expect(await descriptionOf(desktop)).toContain(
    "Connect the browsers you teach your Bots in, and see what OpenBot runs on this computer.",
  );
});

test("in the personal edition, the page says a command one Bot runs can still read another Bot's files", async () => {
  const view = renderPage("personal");
  expect(await descriptionOf(view)).toContain(
    "A command one Bot runs can still read another Bot's files.",
  );
});
