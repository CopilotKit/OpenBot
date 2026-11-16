import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  mock,
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
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  ISOLATED_EXPLAINED,
  ISOLATED_PUBLIC,
  ISOLATION_NOT_ALLOWED,
  ISOLATION_UNAVAILABLE,
} from "@/lib/agents/isolation";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import {
  DEPLOYMENT_PATH,
  deploymentResponse,
  MY_CAPABILITIES_PATH,
} from "./admin-settings-api";
import { APPS_PATH, answerAppsApi, type TodayServer } from "./apps-api";
import {
  botAppPath,
  GIVEABLE_APPS_PATH,
  giveableAppsResponse,
} from "./bot-grants-api";
import {
  BOTS_PATH,
  connectionTestResponse,
  type SentRequest,
  sentRequest,
  TEST_CONNECTION_PATH,
} from "./bots-api";
import { settleReactWork } from "./settle-react-work";

/*
 * `import.meta.glob` is Vite's, and `bun test` has no Vite. Stubbed as the other create tests stub
 * it: a brand with a vendored mark resolves to something drawable, one without to null.
 */
mock.module("@/lib/marks", () => ({
  markFor: (id: string | null | undefined) =>
    id ? `data:image/svg+xml,${id}` : null,
}));

// After the stub: a static import is hoisted and would load the real marks module first.
const { NewBotSheet } = await import("@/components/agents/new-bot-sheet");

/**
 * The New Bot sheet, end to end against a stubbed server.
 *
 * What it promises: a name is the only thing asked for before Continue; where it runs is answered by
 * recognition, with the partners people look for first; a Bot that runs here is created straight
 * from that answer; one somebody else runs is created only once the server has reached its address;
 * and a Bot made with nothing but a name still satisfies a server that requires a title and a role
 * description.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
let edition: "team" | "personal" = "team";
let builtInAvailable = true;
/** Whether the deployment can make a computer for one Bot, and whether the person holds the switch. */
let isolationAvailable = true;
let mayIsolate = true;
/** What the server says when asked to reach an address, or the Response it answers instead. */
let verdict:
  | { ok: true; events: string[] }
  | { ok: false; reason: string }
  | (() => Response);
/** Every request to try an address, as sent. */
let tests: SentRequest[] = [];
/** Every create sent, with its body. */
let creates: Record<string, unknown>[] = [];
/** Every address the server was asked to reach. */
let dialled: string[] = [];
/** The person's own apps the server offers to give a new Bot, and every give it was sent. */
let giveable: {
  key: string;
  displayName: string;
  logo: null;
  account: string;
}[] = [];
let given: string[] = [];
/** Every app that is turned on, as listApps lists them, and every path the sheet asked for. */
let servers: TodayServer[] = [];
let requested: string[] = [];
/** A create the server refuses with this sentence, as it refuses an address it couldn't reach. */
let createRefusal: string | undefined;

beforeEach(() => {
  createRefusal = undefined;
  builtInAvailable = true;
  isolationAvailable = true;
  mayIsolate = true;
  verdict = { ok: true, events: ["RUN_STARTED"] };
  tests = [];
  creates = [];
  dialled = [];
  giveable = [];
  given = [];
  servers = [];
  requested = [];
  global.fetch = Object.assign(
    async (path: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requested.push(String(path));
      if (path === DEPLOYMENT_PATH) {
        return deploymentResponse({
          edition,
          builtInBots: builtInAvailable,
          isolatedBots: isolationAvailable,
        });
      }
      // The switches as they apply to this person, shaped as the API's `people/me/capabilities` answers.
      if (path === MY_CAPABILITIES_PATH) {
        return Response.json({
          capabilities: { isolatedComputers: mayIsolate },
          enforced: true,
        });
      }
      if (path === TEST_CONNECTION_PATH) {
        tests.push(sentRequest(path, init));
        dialled.push(body.endpoint);
        return typeof verdict === "function"
          ? verdict()
          : connectionTestResponse(verdict);
      }
      if (path === BOTS_PATH && init?.method === "POST") {
        if (createRefusal) {
          return Response.json(
            {
              type: "about:blank",
              title: "Bad Request",
              status: 400,
              code: "VALIDATION_ERROR",
              detail: createRefusal,
            },
            {
              status: 400,
              headers: { "content-type": "application/problem+json" },
            },
          );
        }
        creates.push(body);
        return Response.json({ bot: { id: "agent_new" } }, { status: 201 });
      }
      if (String(path).startsWith(GIVEABLE_APPS_PATH))
        return giveableAppsResponse(
          giveable.map((app) => ({
            ...app,
            account: app.account as "personal" | "shared" | "deployment",
          })),
        );
      const apps = answerAppsApi(path, init, { servers });
      if (apps) return apps;
      if (String(path).endsWith("/give") && init?.method === "POST") {
        given.push(String(path));
        return Response.json({ given: [] });
      }
      return new Response(null, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});

afterEach(() => {
  global.fetch = originalFetch;
});

async function draw(screen: ReactNode, drawn: "team" | "personal" = "team") {
  edition = drawn;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  // What this OpenBot offers, read before the sheet opens as the app has read it by then.
  await queryClient.prefetchQuery(deploymentCapabilitiesQueryOptions());
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({ component: () => screen }),
  });
  // Inside the provider the app's root gives every tooltip.
  return render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

/** The sheet open, on its first step: where the Bot will run. */
async function opened(onCreated: (id: string) => void = () => {}) {
  const view = await draw(
    <NewBotSheet onClose={() => {}} onCreated={onCreated} open />,
  );
  await view.findByLabelText("Name");
  const user = userEvent.setup({ document: view.container.ownerDocument });
  return { view, user };
}

async function customFlow() {
  const result = await opened();
  await result.user.type(result.view.getByLabelText("Name"), "Expense Review");
  await result.user.click(
    result.view.getByRole("button", { name: /^Bring your own agent/ }),
  );
  return result;
}
async function connected(address = "https://agent.example.com/ag-ui") {
  const { view, user } = await customFlow();
  expect(view.queryByRole("button", { name: "Continue" })).toBeNull();
  await user.click(view.getByRole("button", { name: /^LangChain/ }));
  if (address)
    await user.type(await view.findByLabelText("Agent address"), address);
  return { view, user };
}

/** Long enough for a request the press started to have reached `fetch`. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

test("opens on New Bot details and creates locally without another screen", async () => {
  const { view, user } = await opened();
  expect(view.getByRole("heading", { name: "New Bot" })).toBeTruthy();
  expect(view.queryByRole("button", { name: /^Run here/ })).toBeNull();
  expect(
    view
      .getByRole("button", { name: /^Bring your own agent/ })
      .hasAttribute("aria-pressed"),
  ).toBe(false);
  // The card names the frameworks it stands for, so the support is visible before it is opened.
  expect(
    view.getByRole("button", {
      name: /Claude Agent SDK, LangChain, Google ADK or \d+ other frameworks\.$/,
    }),
  ).toBeTruthy();
  expect(
    view.getByRole("button", { name: "Create Bot" }).hasAttribute("disabled"),
  ).toBe(true);
  await user.type(view.getByLabelText("Name"), "Expense Review");
  expect(
    view.getByRole("button", { name: "Create Bot" }).hasAttribute("disabled"),
  ).toBe(false);
});

test("unavailable hosting still permits the custom path", async () => {
  builtInAvailable = false;
  const { view, user } = await opened();
  await settle();
  // Whether a Bot can run here is the deployment's to say.
  expect(requested).toContain(DEPLOYMENT_PATH);
  expect(requested.filter((path) => path.includes("/api/agents"))).toEqual([]);
  expect(view.queryByRole("button", { name: /^Run here/ })).toBeNull();
  expect(
    view.queryByRole("button", { name: /^Bring your own agent/ }),
  ).toBeNull();
  expect(
    view.getByRole("button", { name: "Continue" }).hasAttribute("disabled"),
  ).toBe(true);
  await user.type(view.getByLabelText("Name"), "External");
  expect(
    view.getByRole("button", { name: "Continue" }).hasAttribute("disabled"),
  ).toBe(false);
  await user.click(view.getByRole("button", { name: "Continue" }));
  const framework = view.getByRole("button", { name: /^LangChain/ });
  expect(framework.hasAttribute("aria-pressed")).toBe(false);
  expect(view.queryByRole("button", { name: "Continue" })).toBeNull();
  await user.click(framework);
  expect(await view.findByLabelText("Agent address")).toBeTruthy();
  expect(view.getByText("LangChain")).toBeTruthy();
  await user.type(
    view.getByLabelText("Agent address"),
    "https://agent.example.test/ag-ui",
  );
  await user.click(view.getByRole("button", { name: "Create Bot" }));
  await waitFor(() => expect(creates).toHaveLength(1));
  expect(creates[0]?.roleDescription).toBe("Connected from LangChain.");
});

test("Create fills in what was left blank, then hands over", async () => {
  const handedOver: string[] = [];
  const { view, user } = await opened((id) => handedOver.push(id));
  const name = await view.findByLabelText("Name");
  await user.type(name, "Expense Review");
  // Enter in the name is Create.
  await act(async () => {
    fireEvent.keyDown(name, { key: "Enter", keyCode: 13 });
  });

  expect(await view.findByText("Expense Review is ready")).toBeTruthy();
  expect(creates).toHaveLength(1);
  // Its subtitle says what runs it: OpenBot itself.
  expect(creates[0]).toMatchObject({
    name: "Expense Review",
    title: "Powered by OpenBot",
    visibility: "private",
    endpoint: "",
  });
  // It runs on OpenBot, which the server knows without being told.
  expect(creates[0]).not.toHaveProperty("harness");
  // For a Bot that runs here this is its system prompt, so it has to be something it can act on.
  expect(String(creates[0]?.roleDescription)).toStartWith(
    "You are Expense Review.",
  );

  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1800));
  });
  expect(handedOver).toEqual(["agent_new"]);
});

test("refuses an empty or unreachable custom endpoint without creating", async () => {
  verdict = { ok: false, reason: "Nothing answered at that address." };
  const { view, user } = await connected("");
  await user.click(view.getByRole("button", { name: "Create Bot" }));
  expect(await view.findByText("Enter your agent's address.")).toBeTruthy();
  expect(dialled).toEqual([]);
  await user.type(
    view.getByLabelText("Agent address"),
    "https://agent.example.com/ag-ui",
  );
  await user.click(view.getByRole("button", { name: "Create Bot" }));
  expect(
    await view.findByText("Nothing answered at that address."),
  ).toBeTruthy();
  expect(creates).toEqual([]);
});

test("a test the server refused says the server's own sentence, and creates nothing", async () => {
  verdict = () =>
    Response.json(
      {
        type: "about:blank",
        title: "Forbidden",
        status: 403,
        detail: "You can't add Bots that run somewhere else.",
      },
      { status: 403, headers: { "content-type": "application/problem+json" } },
    );
  const { view, user } = await connected();
  await user.click(view.getByRole("button", { name: "Create Bot" }));
  expect(
    await view.findByText("You can't add Bots that run somewhere else."),
  ).toBeTruthy();
  expect(creates).toEqual([]);
});

test("a test that never reached the server says it could not be tested, and creates nothing", async () => {
  verdict = () => {
    throw new TypeError("Failed to fetch");
  };
  const { view, user } = await connected();
  await user.click(view.getByRole("button", { name: "Create Bot" }));
  expect(
    await view.findByText("The connection could not be tested."),
  ).toBeTruthy();
  expect(creates).toEqual([]);
});

test("checks the connection then creates with its saved name and key", async () => {
  const { view, user } = await connected();
  await user.type(view.getByLabelText(/Key/), "Bearer secret");
  await user.click(view.getByRole("button", { name: "Create Bot" }));
  await view.findByText("Expense Review is ready");
  expect(dialled).toEqual(["https://agent.example.com/ag-ui"]);
  // The address is tried at the API's address, with the unsaved key, as a write of its own.
  expect(tests).toEqual([
    {
      method: "POST",
      path: TEST_CONNECTION_PATH,
      key: expect.stringMatching(/^[0-9a-f]{32}$/),
      body: {
        endpoint: "https://agent.example.com/ag-ui",
        headers: { Authorization: "Bearer secret" },
      },
    },
  ]);
  expect(creates[0]).toMatchObject({
    name: "Expense Review",
    endpoint: "https://agent.example.com/ag-ui",
    auth: { header: "Authorization", value: "Bearer secret" },
    // The framework picked from the list, by the name the list showed.
    title: "Powered by LangChain",
    // And by its id, so the Bot is told what runs it whatever its subtitle becomes.
    harness: "langgraph",
  });
});

test("preserves every entry across back navigation and hosting switches", async () => {
  const { view, user } = await connected();
  await user.type(view.getByLabelText(/Key/), "Bearer secret");
  await user.click(view.getByRole("button", { name: "Back" }));
  expect(
    view
      .getByRole("button", { name: /^LangChain/ })
      .getAttribute("aria-pressed"),
  ).toBeNull();
  await user.click(view.getByRole("button", { name: "Back" }));
  expect((view.getByLabelText("Name") as HTMLInputElement).value).toBe(
    "Expense Review",
  );
  await user.type(view.getByLabelText(/^Instructions/), "Review carefully");
  await user.click(view.getByRole("button", { name: /Public/ }));
  expect(
    (view.getByLabelText(/^Instructions/) as HTMLTextAreaElement).value,
  ).toBe("Review carefully");
  await user.click(view.getByRole("button", { name: /^Bring your own agent/ }));
  await user.click(view.getByRole("button", { name: /^LangChain/ }));
  expect((view.getByLabelText("Agent address") as HTMLInputElement).value).toBe(
    "https://agent.example.com/ag-ui",
  );
  expect((view.getByLabelText(/Key/) as HTMLInputElement).value).toBe(
    "Bearer secret",
  );
  await user.click(view.getByRole("button", { name: "Back" }));
  await user.click(view.getByRole("button", { name: "Back" }));
  await user.click(view.getByRole("button", { name: "Create Bot" }));
  await view.findByText("Expense Review is ready");
  expect(creates[0]).toMatchObject({
    endpoint: "",
    visibility: "public",
    roleDescription: "Review carefully",
  });
  expect(creates[0]).not.toHaveProperty("auth");
});

test("the person's own apps arrive ticked, and the ones left ticked are given once the Bot exists", async () => {
  giveable = [
    {
      key: "composio-gmail",
      displayName: "Gmail",
      logo: null,
      account: "personal",
    },
    {
      key: "routines",
      displayName: "Routines",
      logo: null,
      account: "deployment",
    },
  ];
  const { view, user } = await opened();
  await user.type(await view.findByLabelText("Name"), "Research");
  const gmail = await view.findByRole("checkbox", { name: "Gmail" });
  const routines = view.getByRole("checkbox", { name: "Routines" });
  expect(gmail.getAttribute("aria-checked")).toBe("true");
  expect(routines.getAttribute("aria-checked")).toBe("true");
  await user.click(routines);
  expect(routines.getAttribute("aria-checked")).toBe("false");
  await user.click(view.getByRole("button", { name: "Create Bot" }));
  expect(await view.findByText("Research is ready")).toBeTruthy();
  expect(given).toEqual([`${botAppPath("agent_new", "composio-gmail")}/give`]);
});

test("a person with no apps to give is asked nothing about apps", async () => {
  const { view } = await opened();
  await view.findByLabelText("Name");
  await settle();
  expect(view.queryByText("Apps it can use")).toBeNull();
});

/** On the details step the sheet opens on, with a name typed. */
async function named(name = "Research") {
  const { view, user } = await opened();
  await user.type(await view.findByLabelText("Name"), name);
  await settle();
  return { view, user };
}

/** The text of the tooltip beside Isolated, opened the way a pointer opens it. */
async function isolatedTooltip(
  view: Awaited<ReturnType<typeof named>>["view"],
  user: Awaited<ReturnType<typeof named>>["user"],
) {
  await user.hover(view.getByRole("button", { name: "What Isolated means" }));
  return (await view.findByText(new RegExp(ISOLATED_EXPLAINED.slice(0, 30))))
    .textContent;
}

test("Isolated is offered with what it means, and a public Bot is told who shares it", async () => {
  const { view, user } = await named();
  const isolated = await view.findByRole("checkbox", { name: "Isolated" });
  expect(isolated.getAttribute("aria-checked")).toBe("false");
  expect(isolated.hasAttribute("data-disabled")).toBe(false);
  expect(await isolatedTooltip(view, user)).toBe(ISOLATED_EXPLAINED);

  await user.unhover(view.getByRole("button", { name: "What Isolated means" }));
  await user.click(view.getByRole("button", { name: /Public/ }));
  expect(await isolatedTooltip(view, user)).toBe(
    `${ISOLATED_EXPLAINED} ${ISOLATED_PUBLIC}`,
  );
});

test("a ticked Isolated is sent with the Bot, and an unticked one says no", async () => {
  const { view, user } = await named("Research");
  await user.click(await view.findByRole("checkbox", { name: "Isolated" }));
  await user.click(view.getByRole("button", { name: "Create Bot" }));
  expect(await view.findByText("Research is ready")).toBeTruthy();
  expect(creates[0]).toMatchObject({ name: "Research", isolated: true });

  cleanup();
  creates = [];
  const again = await named("Plain");
  await again.user.click(
    again.view.getByRole("button", { name: "Create Bot" }),
  );
  expect(await again.view.findByText("Plain is ready")).toBeTruthy();
  expect(creates[0]).toMatchObject({ name: "Plain", isolated: false });
});

test("a deployment that cannot make a second computer shows Isolated disabled, and says why", async () => {
  isolationAvailable = false;
  const { view, user } = await named();
  const isolated = await view.findByRole("checkbox", { name: "Isolated" });
  expect(isolated.hasAttribute("data-disabled")).toBe(true);
  expect(view.getByText(ISOLATION_UNAVAILABLE)).toBeTruthy();
  await user.click(isolated);
  await user.click(view.getByRole("button", { name: "Create Bot" }));
  await view.findByText("Research is ready");
  expect(creates[0]).toMatchObject({ isolated: false });
});

test("somebody an admin has not allowed sees Isolated disabled, and why", async () => {
  mayIsolate = false;
  const { view } = await named();
  const isolated = await view.findByRole("checkbox", { name: "Isolated" });
  expect(isolated.hasAttribute("data-disabled")).toBe(true);
  expect(await view.findByText(ISOLATION_NOT_ALLOWED)).toBeTruthy();
});

test("custom-agent selection validates the name before advancing", async () => {
  const { view, user } = await opened();
  await user.type(view.getByLabelText("Name"), "   ");
  await user.click(view.getByRole("button", { name: /^Bring your own agent/ }));
  expect((await view.findByRole("alert")).textContent).toBe(
    "Name is required.",
  );
  expect(document.activeElement).toBe(view.getByLabelText("Name"));
  expect(view.queryByRole("button", { name: /^LangChain/ })).toBeNull();
  await user.type(view.getByLabelText("Name"), "My Bot");
  await user.click(view.getByRole("button", { name: /^Bring your own agent/ }));
  expect(await view.findByRole("button", { name: /^LangChain/ })).toBeTruthy();
});

test("personal Bot creation hides team visibility and isolation controls and links to Business", async () => {
  const view = await draw(
    <NewBotSheet open onClose={() => {}} onCreated={() => {}} />,
    "personal",
  );
  await view.findByLabelText("Name");
  expect(view.queryByText("Who can see it")).toBeNull();
  expect(view.queryByRole("checkbox", { name: "Isolated" })).toBeNull();
  // It opens the OpenBot for Business dialog over the sheet, never the website.
  expect(
    view.queryByRole("link", {
      name: "Give each Bot its own computer with OpenBot for Business.",
    }),
  ).toBeNull();
  expect(
    view.getByRole("button", {
      name: "Give each Bot its own computer with OpenBot for Business.",
    }),
  ).toBeTruthy();
  const user = userEvent.setup({ document: view.baseElement.ownerDocument });
  const name = view.getByLabelText("Name");
  await user.type(name, "Personal Research");
  await act(async () => {
    fireEvent.keyDown(name, { key: "Enter", keyCode: 13 });
  });
  await view.findByText("Personal Research is ready");
  expect(creates).toHaveLength(1);
  expect(creates[0]).toMatchObject({ visibility: "private", isolated: false });
});

/**
 * What the Windows personal install showed: Gmail turned on but not connected, Parallel Search on
 * from the start, and Routines. Only Routines is the person's to give, so the sheet listed only
 * Routines, and the Bot it made came out with all three.
 */
const TURNED_ON: TodayServer[] = [
  { id: "composio-gmail", title: "Gmail", logo: null },
  { id: "parallel-search", title: "Parallel Search", logo: null },
  { id: "routines", title: "Routines", logo: null },
];
const ROUTINES_ONLY = [
  {
    key: "routines",
    displayName: "Routines",
    logo: null,
    account: "deployment",
  },
];

test("personal: the sheet lists every app that is turned on, with nothing to untick", async () => {
  servers = TURNED_ON;
  giveable = ROUTINES_ONLY;
  const view = await draw(
    <NewBotSheet open onClose={() => {}} onCreated={() => {}} />,
    "personal",
  );
  const list = await view.findByRole("list", { name: "Apps it can use" });
  expect(
    Array.from(list.querySelectorAll("li")).map((item) => item.textContent),
  ).toEqual([
    "Gmail",
    "Parallel Search",
    // Routines says what asking for one sounds like, and where they all are.
    "Routinese.g. “every weekday at 9, send me…”Open Routines",
  ]);
  expect(
    within(list)
      .getByRole("link", { name: "Open Routines" })
      .getAttribute("href"),
  ).toBe("/routines");
  expect(
    view.getByText("Every Bot can use every app you turn on in Connections."),
  ).toBeTruthy();
  expect(view.queryAllByRole("checkbox")).toHaveLength(0);
});

test("team: the sheet offers only the apps the person can give, ticked", async () => {
  servers = TURNED_ON;
  giveable = ROUTINES_ONLY;
  const { view } = await opened();
  const routines = await view.findByRole("checkbox", { name: "Routines" });
  expect(routines.getAttribute("aria-checked")).toBe("true");
  expect(view.queryByText("Gmail")).toBeNull();
  expect(view.queryByText("Parallel Search")).toBeNull();
  expect(
    view.getByText("It always uses the account of whoever is asking."),
  ).toBeTruthy();
  expect(requested.filter((path) => path.startsWith(APPS_PATH))).toEqual([]);
});

/**
 * Mastra is offered beside the others, with its mark, and picking it connects a Mastra server.
 *
 * A Mastra server has no AG-UI route, so the AG-UI test can only fail against one. The create carries
 * the framework instead, and the server proves the address against Mastra's own API before it saves
 * anything. What it refused with is shown under the address, as a failed test is.
 */
test("Mastra is offered with its mark, and picking it connects a Mastra server", async () => {
  const { view, user } = await customFlow();
  const mastra = view.getByRole("button", { name: /^Mastra/ });
  const mark = mastra.querySelector("img[data-mark='Mastra']");
  expect(mark?.getAttribute("src")).toBe("data:image/svg+xml,mastra");

  await user.click(mastra);
  expect(view.getByText("Mastra")).toBeTruthy();
  await user.type(
    await view.findByLabelText("Agent address"),
    "https://mastra.example.com",
  );
  await user.click(view.getByRole("button", { name: "Create Bot" }));
  await view.findByText("Expense Review is ready");
  expect(tests).toEqual([]);
  expect(creates[0]).toMatchObject({
    endpoint: "https://mastra.example.com",
    title: "Powered by Mastra",
    harness: "mastra",
  });
});

test("an address the server could not reach as a Mastra server says why, under the address", async () => {
  const refusal =
    "Couldn't reach a Mastra server at that address. It runs no agents.";
  const { view, user } = await customFlow();
  await user.click(view.getByRole("button", { name: /^Mastra/ }));
  await user.type(
    await view.findByLabelText("Agent address"),
    "https://mastra.example.com",
  );
  createRefusal = refusal;
  await user.click(view.getByRole("button", { name: "Create Bot" }));
  expect(await view.findByText(refusal)).toBeTruthy();
  expect(view.getAllByText(refusal)).toHaveLength(1);
  expect(view.queryByText("Expense Review is ready")).toBeNull();
});

test("the LangGraph harness is offered as LangChain, the name people know it by", async () => {
  const { view } = await customFlow();
  const framework = view.getByRole("button", { name: /^LangChain/ });
  // LangChain's own name and a description that doesn't talk about graphs.
  expect(framework.textContent).not.toMatch(/Graph/);
});
