import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
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
import { act, cleanup, render } from "@testing-library/react";
import type { ReactElement } from "react";
import { ComputerChatControls } from "@/components/computer/computer-controls";
import { ComputerViewPanel } from "@/components/computer/computer-panel";
import { HandoffResumeNotice } from "@/components/computer/handoff-resume-notice";
import { ComputersPage } from "@/components/manage/computers-page";
import { SavedLogins } from "@/components/vault/saved-logins";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { Route as AdminComputersRoute } from "@/routes/_authed/admin/computers";
import { ME_PATH, meResponse } from "./accounts-api";
import {
  DEPLOYMENT_PATH,
  deploymentResponse,
  overviewResponse,
} from "./admin-settings-api";
import { settleReactWork } from "./settle-react-work";

/**
 * An OpenBot with no computers for Bots says so on the three screens that are about one, and asks
 * the server for nothing that can never work there.
 *
 * The deployment says whether this OpenBot has computers for Bots (`botComputers`). Without them the
 * server refuses every call about a computer with a 503 and one sentence, a Bot's browser reads as
 * closed, and the saved logins are an empty list with the password manager off. The screens used to
 * turn those answers into "Couldn't load the computers. Reload the page.", "Starting the Bot's
 * computer" for two and a half minutes, and "An admin turned them off."
 *
 * Drawn for real: each screen with its own queries and the generated client, against a server
 * stand-in at the API's addresses that answers as the server does in each state and keeps every
 * request it was sent.
 */

const ORGANIZATION = "/api/v2/organizations/default";
const COMPUTERS_PATH = `${ORGANIZATION}/computers`;
const SAVED_LOGINS_PATH = `${ORGANIZATION}/people/me/saved-logins`;
const HOST_ACCESS_PATH = `${ORGANIZATION}/people/me/host-access`;
const BOTS_PATH = `${ORGANIZATION}/bots`;
const BOT = "fernhill-guide";

/** What the server says about every computer where there are none. */
const NO_COMPUTERS_SENTENCE = "This OpenBot has no computers for Bots.";

class SocketDouble {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  readyState = SocketDouble.OPEN;
  binaryType = "blob";
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly url: string) {
    queueMicrotask(() => this.onopen?.());
  }
  send() {}
  close() {
    this.readyState = SocketDouble.CLOSED;
  }
}

let originalFetch: typeof fetch;
let originalWebSocket: typeof WebSocket;
let originalIntersectionObserver: typeof IntersectionObserver | undefined;
let originalDecode: typeof HTMLImageElement.prototype.decode;

beforeAll(() => {
  GlobalRegistrator.register();
  originalFetch = globalThis.fetch;
  originalWebSocket = globalThis.WebSocket;
  originalIntersectionObserver = globalThis.IntersectionObserver;
  originalDecode = HTMLImageElement.prototype.decode;
  globalThis.WebSocket = SocketDouble as unknown as typeof WebSocket;
  // Without an observer the Bot's screen counts as on screen, so it reads what it would in the app.
  Reflect.deleteProperty(globalThis, "IntersectionObserver");
  HTMLImageElement.prototype.decode = () => Promise.resolve();
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  globalThis.WebSocket = originalWebSocket;
  if (originalIntersectionObserver)
    globalThis.IntersectionObserver = originalIntersectionObserver;
  HTMLImageElement.prototype.decode = originalDecode;
  GlobalRegistrator.unregister();
});

type Deployment =
  /** The deployment answers, and says whether there are computers for Bots. */
  | { botComputers: boolean }
  /** The deployment has not answered yet. */
  | "loading"
  /** The deployment could not be read. */
  | "failed";

/**
 * The server, as it answers on an OpenBot with computers for Bots (`computers: true`) or without.
 * `passwordManager: false` is an admin having turned saved logins off where there are computers.
 */
function serve({
  computers,
  deployment = { botComputers: computers },
  passwordManager = computers,
}: {
  computers: boolean;
  deployment?: Deployment;
  passwordManager?: boolean;
}) {
  const asked: string[] = [];
  const unavailable = () =>
    Response.json(
      {
        type: "about:blank",
        title: "Service Unavailable",
        status: 503,
        code: "SERVICE_UNAVAILABLE",
        detail: NO_COMPUTERS_SENTENCE,
      },
      { status: 503, headers: { "content-type": "application/problem+json" } },
    );
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), "http://openbot.test").pathname;
    asked.push(`${init?.method ?? "GET"} ${path}`);
    if (path === DEPLOYMENT_PATH) {
      if (deployment === "loading") return new Promise<Response>(() => {});
      if (deployment === "failed")
        return Response.json({ detail: "Not now." }, { status: 500 });
      return deploymentResponse(deployment);
    }
    if (path === ME_PATH)
      return meResponse({ user: { id: "ada", name: "Ada", role: "admin" } });
    const overview = overviewResponse(path, {});
    if (overview) return overview;
    // The Network section names a team's policy by the team's name. This organization has none.
    if (path.split("?")[0] === "/api/v2/organizations/default/teams")
      return Response.json({ teams: [], canCreate: true, nextCursor: null });
    // A server's install, not OpenBot Desktop: no folders on this computer to choose.
    if (path === HOST_ACCESS_PATH)
      return Response.json({
        connected: false,
        desktop: false,
        grants: [],
        pending: [],
      });
    if (path === BOTS_PATH)
      return Response.json({ bots: [], nextCursor: null });
    if (path === SAVED_LOGINS_PATH)
      return Response.json({
        savedLogins:
          computers && passwordManager
            ? [
                {
                  id: "l1",
                  origin: "https://example.com",
                  username: "ada@example.com",
                  createdAt: "2026-11-01T00:00:00Z",
                  updatedAt: "2026-11-01T00:00:00Z",
                  lastUsedAt: null,
                },
              ]
            : [],
        passwordManager: computers && passwordManager,
        nextCursor: null,
      });
    if (path === COMPUTERS_PATH || path.startsWith(`${COMPUTERS_PATH}/`)) {
      if (!computers) return unavailable();
      if (path === COMPUTERS_PATH)
        return Response.json({
          computers: [
            {
              computer: `bot:${BOT}`,
              kind: "bot",
              botId: BOT,
              running: true,
              startedAt: "2026-11-07T04:21:42.051Z",
              egress: null,
            },
          ],
          isolation: "per-person",
          nextCursor: null,
        });
      if (path === `${COMPUTERS_PATH}/${BOT}`)
        return Response.json({ botId: BOT, state: "ready" });
      if (path === `${COMPUTERS_PATH}/${BOT}/control`)
        return Response.json({
          holder: "bot",
          since: new Date(0).toISOString(),
          requested: false,
        });
      if (path === `${COMPUTERS_PATH}/${BOT}/screenshot`)
        return Response.json({
          base64: "AAAA",
          width: 320,
          height: 200,
          capturedAt: new Date(0).toISOString(),
          url: "https://example.com/",
        });
    }
    return Response.json({ detail: "Not here." }, { status: 404 });
  }) as typeof fetch;
  return {
    asked,
    /** Every request about a computer: the list, and a Bot's status, control and screenshot. */
    aboutComputers: () =>
      asked.filter((request) => request.includes(COMPUTERS_PATH)),
  };
}

function draw(
  ui: ReactElement,
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({ component: () => ui }),
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

/** Long enough for a screen's first reads, and the ones a second later, to have been sent. */
async function settle(ms = 250) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

const AdminComputers = AdminComputersRoute.options
  .component as () => ReactElement;

/** The page's words for the controls that act on a computer. */
const FOOTER = /closes the computer's browsers/;

describe("the Computer pages", () => {
  test("Admin's Computers says this OpenBot has no computers for Bots, with no controls, and never asks for the list", async () => {
    const server = serve({ computers: false });
    const view = draw(<AdminComputers />);

    expect(await view.findByText("No computers for Bots")).toBeTruthy();
    expect(view.getByText(/Bots can't browse or run commands/)).toBeTruthy();
    await settle();
    expect(view.queryByRole("alert")).toBeNull();
    expect(view.queryByText(/Couldn't load/)).toBeNull();
    // No Stop, Reset or Update, no words about them, and nothing about idle computers.
    expect(view.queryByText(FOOTER)).toBeNull();
    expect(
      view.queryByRole("button", { name: /Stop|Reset|Update/ }),
    ).toBeNull();
    expect(view.queryByRole("heading", { name: "Idle computers" })).toBeNull();
    expect(server.aboutComputers()).toEqual([]);
  });

  test("a Bot's Computer page says the same, with no controls, and never asks for the list", async () => {
    const server = serve({ computers: false });
    const view = draw(<ComputersPage agentId={BOT} />);

    expect(await view.findByText("No computers for Bots")).toBeTruthy();
    await settle();
    expect(view.queryByRole("alert")).toBeNull();
    expect(view.queryByText(FOOTER)).toBeNull();
    expect(
      view.queryByRole("button", { name: /Stop|Reset|Update/ }),
    ).toBeNull();
    expect(server.aboutComputers()).toEqual([]);
  });

  test("where there are computers, Admin's Computers lists them with its controls and the idle computers", async () => {
    const server = serve({ computers: true });
    const view = draw(<AdminComputers />);

    expect(
      await view.findByRole("button", { name: "Stop browser" }),
    ).toBeTruthy();
    expect(view.getByRole("button", { name: "Reset" })).toBeTruthy();
    expect(view.getByText(FOOTER)).toBeTruthy();
    expect(
      await view.findByRole("heading", { name: "Idle computers" }),
    ).toBeTruthy();
    expect(view.queryByText("No computers for Bots")).toBeNull();
    expect(server.aboutComputers()).toEqual([`GET ${COMPUTERS_PATH}`]);
  });

  test("until the deployment has answered, the page says neither that there are no computers nor that it failed", async () => {
    const server = serve({ computers: false, deployment: "loading" });
    const view = draw(<AdminComputers />);

    expect(
      await view.findByRole("heading", { name: "Computers" }),
    ).toBeTruthy();
    await settle();
    expect(view.queryByText("No computers for Bots")).toBeNull();
    expect(view.queryByRole("alert")).toBeNull();
    expect(view.queryByText(/Couldn't load/)).toBeNull();
    expect(server.aboutComputers()).toEqual([]);
  });

  test("a deployment that could not be read leaves the page as it was: it asks for the list", async () => {
    const server = serve({ computers: true, deployment: "failed" });
    const view = draw(<AdminComputers />);

    expect(
      await view.findByRole("button", { name: "Stop browser" }),
    ).toBeTruthy();
    expect(view.queryByText("No computers for Bots")).toBeNull();
    expect(server.aboutComputers()).toEqual([`GET ${COMPUTERS_PATH}`]);
  });
});

describe("the Computer beside a conversation", () => {
  test("says at once that this OpenBot has no computers for Bots, and reads no status, control or screenshot", async () => {
    const server = serve({ computers: false });
    const view = draw(
      <ComputerViewPanel agentId={BOT} name="Fernhill Guide" />,
    );

    expect(await view.findByText("No computers for Bots")).toBeTruthy();
    expect(view.getByText(/Bots can't browse or run commands/)).toBeTruthy();
    // Past the next second's reads too: who has control is read every second where there is a computer.
    await settle(1200);
    expect(view.queryByText(/^Starting/)).toBeNull();
    expect(view.queryByText(/Can't show the screen/)).toBeNull();
    expect(view.queryByRole("alert")).toBeNull();
    // Nothing left of a computer to open, drive or watch.
    expect(view.queryByRole("tab")).toBeNull();
    expect(view.queryByRole("button")).toBeNull();
    expect(view.queryByText("Activity")).toBeNull();
    expect(server.aboutComputers()).toEqual([]);
  });

  test("the header's Open Computer button is still there, and reads no control", async () => {
    const server = serve({ computers: false });
    const view = draw(
      <ComputerChatControls
        computerId={BOT}
        noComputers
        onOpenChange={() => {}}
        open={false}
      />,
    );

    const button = await view.findByRole("button", { name: "Open Computer" });
    expect(button.hasAttribute("disabled")).toBe(false);
    await settle(1200);
    expect(server.aboutComputers()).toEqual([]);
  });

  test("where there are computers, the panel is the Bot's screen and terminal, read as before", async () => {
    const server = serve({ computers: true });
    const view = draw(
      <ComputerViewPanel agentId={BOT} name="Fernhill Guide" />,
    );

    expect(await view.findByRole("tab", { name: "Screen" })).toBeTruthy();
    expect(view.getByRole("tab", { name: "Terminal" })).toBeTruthy();
    expect(await view.findByAltText("What the Bot is looking at")).toBeTruthy();
    expect(
      await view.findByRole("button", { name: "Take control" }),
    ).toBeTruthy();
    expect(view.getByText("Activity")).toBeTruthy();
    expect(view.queryByText("No computers for Bots")).toBeNull();
    const about = new Set(server.aboutComputers());
    expect(about.has(`GET ${COMPUTERS_PATH}/${BOT}/control`)).toBe(true);
    expect(about.has(`GET ${COMPUTERS_PATH}/${BOT}/screenshot`)).toBe(true);
  });

  test("until the deployment has answered, the panel says neither that there are no computers nor that it failed", async () => {
    const server = serve({ computers: false, deployment: "loading" });
    const view = draw(
      <ComputerViewPanel agentId={BOT} name="Fernhill Guide" />,
    );

    await settle();
    // The deployment was asked, and nothing is drawn until it answers.
    expect(server.asked).toContain(`GET ${DEPLOYMENT_PATH}`);
    expect(view.queryByRole("tab")).toBeNull();
    expect(view.queryByText("No computers for Bots")).toBeNull();
    expect(view.queryByText(/Can't show the screen/)).toBeNull();
    // The wheel's first read is refused at once where there are no computers, and said as a failure.
    expect(view.queryByRole("alert")).toBeNull();
    expect(server.aboutComputers()).toEqual([]);
  });

  test("a deployment that could not be read leaves the panel as it was: the Bot's screen and terminal", async () => {
    const server = serve({ computers: true, deployment: "failed" });
    const view = draw(
      <ComputerViewPanel agentId={BOT} name="Fernhill Guide" />,
    );

    expect(await view.findByRole("tab", { name: "Screen" })).toBeTruthy();
    expect(await view.findByAltText("What the Bot is looking at")).toBeTruthy();
    expect(view.queryByText("No computers for Bots")).toBeNull();
    expect(server.aboutComputers()).toContain(
      `GET ${COMPUTERS_PATH}/${BOT}/screenshot`,
    );
  });
});

/*
 * Every open conversation looks, once a second, for a browser task of its Bot's that was left
 * waiting on the person, by reading who has control of the Bot's computer. Where there are no
 * computers that read is refused every second for as long as the conversation is open. (The whole
 * conversation is drawn in no-bot-computers-conversation.test.tsx.)
 */
describe("a conversation's check for a paused browser task", () => {
  const quiet = { messages: [], isRunning: false, setMessages: () => {} };
  const notice = (
    <HandoffResumeNotice agent={quiet} botId={BOT} ready run={async () => {}} />
  );

  test("reads no control where there are no computers for Bots", async () => {
    const server = serve({ computers: false });
    // As in the app, where the deployment was read long before a conversation opened.
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    await client.fetchQuery(deploymentCapabilitiesQueryOptions());
    draw(notice, client);

    // Two of its seconds.
    await settle(2300);
    expect(server.aboutComputers()).toEqual([]);
    expect(server.asked).toContain(`GET ${DEPLOYMENT_PATH}`);
  });

  test("reads control every second where there are computers, as before", async () => {
    const server = serve({ computers: true });
    draw(notice);

    await settle(2300);
    const reads = server
      .aboutComputers()
      .filter((request) => request === `GET ${COMPUTERS_PATH}/${BOT}/control`);
    expect(reads.length).toBeGreaterThanOrEqual(2);
  });

  test("reads control as before when the deployment could not be read", async () => {
    const server = serve({ computers: true, deployment: "failed" });
    draw(notice);

    await settle(1300);
    expect(server.aboutComputers()).toContain(
      `GET ${COMPUTERS_PATH}/${BOT}/control`,
    );
  });
});

describe("the Vault's saved logins", () => {
  test("say this OpenBot has no computer for Bots, not that an admin turned them off", async () => {
    serve({ computers: false });
    const view = draw(<SavedLogins />);

    expect(await view.findByText("Saved logins aren't available")).toBeTruthy();
    expect(
      view.getByText(/need a computer for Bots, and this OpenBot has none/),
    ).toBeTruthy();
    await settle();
    expect(view.queryByText("Saved logins are off")).toBeNull();
    expect(view.queryByText(/An admin turned them off/)).toBeNull();
    expect(view.queryByRole("alert")).toBeNull();
  });

  test("where there are computers and an admin turned saved logins off, say that", async () => {
    serve({ computers: true, passwordManager: false });
    const view = draw(<SavedLogins />);

    expect(await view.findByText("Saved logins are off")).toBeTruthy();
    expect(view.getByText(/An admin turned them off/)).toBeTruthy();
    expect(view.queryByText("Saved logins aren't available")).toBeNull();
  });

  test("where there are computers, list the logins as before", async () => {
    serve({ computers: true });
    const view = draw(<SavedLogins />);

    expect(await view.findByText("https://example.com")).toBeTruthy();
    expect(view.queryByText("Saved logins aren't available")).toBeNull();
    expect(view.queryByText("Saved logins are off")).toBeNull();
  });

  test("until the deployment has answered, say neither why there are none nor that it failed", async () => {
    const server = serve({ computers: false, deployment: "loading" });
    const view = draw(<SavedLogins />);

    await settle();
    // The list itself has answered: empty, with the password manager off.
    expect(server.asked).toContain(`GET ${SAVED_LOGINS_PATH}`);
    expect(view.queryByText("Saved logins aren't available")).toBeNull();
    expect(view.queryByText("Saved logins are off")).toBeNull();
    expect(view.queryByRole("alert")).toBeNull();
  });

  test("a deployment that could not be read leaves the words as they were", async () => {
    serve({ computers: true, passwordManager: false, deployment: "failed" });
    const view = draw(<SavedLogins />);

    expect(await view.findByText("Saved logins are off")).toBeTruthy();
  });
});
