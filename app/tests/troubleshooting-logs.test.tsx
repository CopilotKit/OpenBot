/**
 * Get troubleshooting logs, from the menu under the person's name.
 *
 * Found on a dogfood of my.open.bot in a browser: "Where are the logs? I'd expect a button or menu
 * item that makes it easy to generate those and send them in", covering the last bit of time,
 * scanned for secrets, and saying the secrets were removed.
 *
 * In a browser the page writes the file itself and hands it over as a download: the problems it
 * met in the last 30 minutes (a request that failed, with the server's request id; an error it
 * threw), with keys, tokens and email addresses taken out and the ids kept. Inside OpenBot Desktop
 * the desktop app saves its own file (`save_logs`); a desktop app without that command gets the
 * page's file instead. The sidebar, its menu, the client and the toast are the app's own; the
 * server is a stand-in `fetch`, and the desktop app stands in at `__TAURI_INTERNALS__`.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  spyOn,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { RELEASE } from "@openbot/shared/client-version";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppSidebar } from "@/components/app-sidebar/app-sidebar";
import { SidebarProvider } from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/toast";
import { agentKeys } from "@/lib/agents/queries";
import { authKeys } from "@/lib/auth/queries";
import { botLifecycleKeys } from "@/lib/bot-lifecycle/queries";
import { channelKeys } from "@/lib/channels/queries";
import { client } from "@/lib/client";
import { deploymentKeys } from "@/lib/deployment/queries";
import { type ProblemClock, setProblemClock } from "@/lib/desktop/problems";
import {
  installAppErrorReporting,
  resetAppErrorReports,
} from "@/lib/error-reporting";
import { setCurrentOrganization } from "@/lib/organizations/current";
import { organizationKeys } from "@/lib/organizations/queries";
import { userPreferencesQueryOptions } from "@/lib/settings/message-list";
import {
  installDesktopShell,
  removeDesktopShell,
  type ShellCall,
} from "./desktop-shell.fixture";
import { settleReactWork } from "./settle-react-work";

// Better Auth makes ids as 32 letters and digits, both cases.
const ORGANIZATION = "Kd8fJ2pQ".repeat(4);
const PERSON = "Wm4nR7tY".repeat(4);
const REQUEST_ID = "req_5f0d6c0e-2f1a-4a53-9d51-6f3d6b1f6f10";
const VERSION = "1.2.0-rc.4";
const NOW = Date.parse("2026-11-24T10:30:00.000Z");
// Built here, so no key-shaped literal sits in the source.
const KEY = `sk-ant-api03-${"Ab9_".repeat(12)}`;
const SAVED =
  "Keys, tokens, passwords, cookies and email addresses were removed before it was saved.";

class OfflineWebSocket extends EventTarget {
  readyState = 0;
  onclose = null;
  onerror = null;
  onmessage = null;
  onopen = null;
  close() {}
  send() {}
}

const originalFetch = globalThis.fetch;
const originalWebSocket = globalThis.WebSocket;
let now = NOW;
const clock: ProblemClock = {
  now: () => now,
  setTimeout: () => 0,
  clearTimeout: () => {},
};
let queryClient: QueryClient;
let downloads: { name: string; blob: Blob }[] = [];
let calls: ShellCall[] = [];

beforeAll(() => {
  (globalThis as Record<string, unknown>).__OPENBOT_APP_VERSION__ = VERSION;
  GlobalRegistrator.register({ url: "https://my.open.bot/" });
  globalThis.WebSocket = OfflineWebSocket as unknown as typeof WebSocket;
});
beforeEach(() => {
  now = NOW;
  downloads = [];
  calls = [];
  resetAppErrorReports();
  setProblemClock(clock);
  setCurrentOrganization(ORGANIZATION);
  // The server: a conversation can't be started, and anything else is not served.
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const path = new URL(String(input), location.href).pathname;
      // The page's own error reports are taken, as the server takes them.
      if (path.endsWith("/app-errors"))
        return new Response(null, { status: 204 });
      if (path.endsWith("/conversations"))
        return Response.json(
          {
            type: "https://open.bot/errors/internal",
            title: "Internal error",
            status: 500,
            detail: "Couldn't start a conversation.",
            requestId: REQUEST_ID,
          },
          {
            status: 500,
            headers: {
              "content-type": "application/problem+json",
              "x-request-id": REQUEST_ID,
            },
          },
        );
      return Response.json({ error: "not served" }, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
  // The download, as the browser receives it: the Blob behind the link's address, and its name.
  const blobs = new Map<string, Blob>();
  spyOn(URL, "createObjectURL").mockImplementation((blob) => {
    const url = `blob:https://my.open.bot/${blobs.size + 1}`;
    blobs.set(url, blob as Blob);
    return url;
  });
  spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    const blob = blobs.get(this.href);
    if (blob) downloads.push({ name: this.download, blob });
  });
});
afterEach(async () => {
  cleanup();
  queryClient?.clear();
  removeDesktopShell();
  setProblemClock();
  setCurrentOrganization(undefined);
  globalThis.fetch = originalFetch;
  await settleReactWork();
});
afterAll(async () => {
  delete (globalThis as Record<string, unknown>).__OPENBOT_APP_VERSION__;
  await settleReactWork();
  globalThis.WebSocket = originalWebSocket;
  GlobalRegistrator.unregister();
});

/** The app's sidebar for a signed-in person, with its toasts. */
function renderSidebar() {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    selfHostBanner: false,
    localEvaluation: false,
    edition: "team",
  });
  queryClient.setQueryData(authKeys.currentUser(), {
    id: PERSON,
    name: "Maya Chen",
    email: "maya@example.com",
    role: "user",
    onboarding: null,
    openbotVersion: "1.2.0",
  });
  queryClient.setQueryData(userPreferencesQueryOptions(PERSON).queryKey, {
    messageListEmphasis: "thread",
    selfHostBannerDismissed: true,
    dismissedNotices: [],
    narration: null,
    skin: "openbot",
    proactive: "on",
  });
  // The organization the person works in, as the server named it.
  queryClient.setQueryData(organizationKeys.mine(), {
    organizations: [],
    canCreate: false,
    currentId: ORGANIZATION,
  });
  queryClient.setQueryData(agentKeys.list(false), []);
  queryClient.setQueryDefaults(botLifecycleKeys.attention, {
    staleTime: Number.POSITIVE_INFINITY,
    refetchInterval: false,
  });
  queryClient.setQueryData(botLifecycleKeys.attention, {
    bots: [],
    lastPingId: null,
  });
  queryClient.setQueryData(channelKeys.list(), {
    pages: [{ channels: [], nextCursor: null }],
    pageParams: [""],
  });
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => (
        <SidebarProvider>
          <AppSidebar />
          <Toaster />
        </SidebarProvider>
      ),
    }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { view, user: userEvent.setup({ document }) };
}

/** What the person meets before asking for the logs: an old error, then two new problems. */
async function somethingWentWrong() {
  installAppErrorReporting();
  // Forty minutes ago: outside the half hour the file covers.
  now = NOW - 40 * 60_000;
  window.dispatchEvent(
    new ErrorEvent("error", { error: new Error("from long ago") }),
  );
  now = NOW - 60_000;
  await client(
    `/api/v2/organizations/${ORGANIZATION}/conversations?token=tok_abc123&email=maya@example.com`,
    { method: "POST", body: { email: "maya@example.com" } },
  ).catch(() => undefined);
  now = NOW - 30_000;
  window.dispatchEvent(
    new ErrorEvent("error", {
      error: new TypeError(`can't read ${KEY} for maya@example.com`),
      filename: "https://my.open.bot/assets/index-B2x9.js?v=3",
      lineno: 12,
      colno: 345,
    }),
  );
  now = NOW;
}

async function chooseGetTroubleshootingLogs() {
  const { view, user } = renderSidebar();
  // Whatever drawing the sidebar asked for is not what this test is about.
  await settleReactWork();
  setProblemClock(clock);
  setCurrentOrganization(ORGANIZATION);
  await somethingWentWrong();
  await user.click(await view.findByRole("button", { name: /Maya Chen/ }));
  const menu = await view.findByRole("menu");
  const items = within(menu)
    .getAllByRole("menuitem")
    .map((item) => item.textContent?.trim());
  // Just above Sign out, where a person looks for help.
  expect(items.slice(-2)).toEqual(["Get troubleshooting logs", "Sign out"]);
  await user.click(
    within(menu).getByRole("menuitem", { name: "Get troubleshooting logs" }),
  );
}

const toasts = () =>
  [...document.querySelectorAll("[data-slot=toast]")].map(
    (toast) => toast.textContent,
  );

const FILE = "openbot-troubleshooting-2026-11-24T10-30-00Z.txt";

test("in a browser, the item saves one file of the last 30 minutes, secrets taken out and ids kept, and says so", async () => {
  await chooseGetTroubleshootingLogs();
  await waitFor(() => expect(downloads).toHaveLength(1));
  const [download] = downloads;
  expect(download?.name).toBe(FILE);
  const text = await download?.blob.text();
  expect(text).toBe(
    [
      "OpenBot troubleshooting logs",
      "Redacted before saving: API keys, tokens, passwords, cookies and email addresses. Request, account and organization ids are kept, so a failure can be found in the server's logs.",
      "Made 2026-11-24T10:30:00.000Z, covering the last 30 minutes (from 2026-11-24T10:00:00.000Z).",
      "",
      "Address: https://my.open.bot",
      `Front end: ${VERSION}`,
      "OpenBot: 1.2.0",
      `Organization: ${ORGANIZATION}`,
      `Account: ${PERSON}`,
      `Browser: ${navigator.userAgent}`,
      "",
      "Problems the app met:",
      `2026-11-24T10:29:00.000Z request POST /api/v2/organizations/${ORGANIZATION}/conversations: answered 500, request id ${REQUEST_ID}`,
      "2026-11-24T10:29:30.000Z page error: TypeError: can't read [redacted] for [email] (at https://my.open.bot/assets/index-B2x9.js:12:345)",
      "",
    ].join("\n"),
  );
  for (const gone of [
    "tok_abc123",
    "maya@example.com",
    KEY,
    "?",
    "from long ago",
  ])
    expect([gone, text?.includes(gone)]).toEqual([gone, false]);
  await waitFor(() =>
    expect(toasts()).toEqual([
      `Troubleshooting logs savedSaved as ${FILE}. ${SAVED}`,
    ]),
  );
});

test("with nothing gone wrong, the file says so", async () => {
  const { view, user } = renderSidebar();
  await settleReactWork();
  setProblemClock(clock);
  await user.click(await view.findByRole("button", { name: /Maya Chen/ }));
  await user.click(
    await view.findByRole("menuitem", { name: "Get troubleshooting logs" }),
  );
  await waitFor(() => expect(downloads).toHaveLength(1));
  const text = await downloads[0]?.blob.text();
  expect(
    text?.endsWith("Problems the app met:\nNone in the last 30 minutes.\n"),
  ).toBe(true);
});

/**
 * FOUND ON A TEST OPENBOT: its image's web app had no build label, and the file said its version
 * wasn't known while every request named `web/<release>`. The file names that release then.
 */
test("a web app with no build label names the release it was built from", async () => {
  delete (globalThis as Record<string, unknown>).__OPENBOT_APP_VERSION__;
  const { view, user } = renderSidebar();
  await settleReactWork();
  setProblemClock(clock);
  await user.click(await view.findByRole("button", { name: /Maya Chen/ }));
  await user.click(
    await view.findByRole("menuitem", { name: "Get troubleshooting logs" }),
  );
  await waitFor(() => expect(downloads).toHaveLength(1));
  expect(await downloads[0]?.blob.text()).toContain(`Front end: ${RELEASE}\n`);
});

test("inside OpenBot Desktop, the item has the desktop app save its own file, and says where", async () => {
  calls = installDesktopShell().calls;
  await chooseGetTroubleshootingLogs();
  await waitFor(() =>
    expect(toasts()).toEqual([
      `Troubleshooting logs savedSaved in OpenBot Desktop's log folder. ${SAVED}`,
    ]),
  );
  expect(
    calls
      .map((call) => call.command)
      .filter((command) => command.endsWith("|save_logs")),
  ).toEqual(["plugin:openbot-desktop|save_logs"]);
  expect(downloads).toEqual([]);
});

test("a desktop app without save_logs refuses it, and the page saves its own file", async () => {
  const asked: string[] = [];
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    transformCallback: () => 0,
    invoke: async (command: string) => {
      asked.push(command);
      if (command.endsWith("|save_logs"))
        // How Tauri refuses a command a plugin does not have: a rejection carrying a string.
        throw `Command ${command} not found`;
      return null;
    },
  };
  await chooseGetTroubleshootingLogs();
  await waitFor(() => expect(downloads).toHaveLength(1));
  expect(asked.filter((command) => command.endsWith("|save_logs"))).toEqual([
    "plugin:openbot-desktop|save_logs",
  ]);
  expect(await downloads[0]?.blob.text()).toContain(
    `answered 500, request id ${REQUEST_ID}`,
  );
  await waitFor(() =>
    expect(toasts()).toEqual([
      `Troubleshooting logs savedSaved as ${FILE}. ${SAVED}`,
    ]),
  );
});

test("a desktop app that couldn't save says so, and nothing else is saved", async () => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    transformCallback: () => 0,
    invoke: async (command: string) => {
      // The desktop app's own sentence, as Tauri hands a command's Err to the page.
      if (command.endsWith("|save_logs"))
        throw "OpenBot couldn't save the troubleshooting logs. Try again.";
      return null;
    },
  };
  await chooseGetTroubleshootingLogs();
  await waitFor(() =>
    expect(toasts()).toEqual([
      "Couldn't save the troubleshooting logs. Try again.",
    ]),
  );
  expect(downloads).toEqual([]);
});
