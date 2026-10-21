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
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
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
let builtInAvailable = true;
/** What the server says when asked to reach an address. */
let verdict: { ok: true; events: string[] } | { ok: false; reason: string };
/** Every create sent, with its body. */
let creates: Record<string, unknown>[] = [];
/** Every address the server was asked to reach. */
let dialled: string[] = [];

beforeEach(() => {
  builtInAvailable = true;
  verdict = { ok: true, events: ["RUN_STARTED"] };
  creates = [];
  dialled = [];
  global.fetch = Object.assign(
    async (path: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (path === "/api/agents/capabilities") {
        return Response.json({ capabilities: { builtInAvailable } });
      }
      if (path === "/api/agents/test-connection") {
        dialled.push(body.endpoint);
        return Response.json(verdict);
      }
      if (path === "/api/agents" && init?.method === "POST") {
        creates.push(body);
        return Response.json({ agent: { id: "agent_new" } }, { status: 201 });
      }
      return new Response(null, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});

afterEach(() => {
  global.fetch = originalFetch;
});

function draw(screen: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({ component: () => screen }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

/** The sheet open, on its first step: where the Bot will run. */
async function opened(onCreated: (id: string) => void = () => {}) {
  const view = draw(
    <NewBotSheet onClose={() => {}} onCreated={onCreated} open />,
  );
  await view.findByText("Where will your Bot run?");
  const user = userEvent.setup({ document: view.container.ownerDocument });
  return { view, user };
}

/** A framework chosen and its address answered, which lands on the last step. */
async function connected(onCreated?: (id: string) => void) {
  const { view, user } = await opened(onCreated);
  await user.click(view.getByRole("button", { name: /LangGraph/ }));
  await user.click(view.getByRole("button", { name: "Continue" }));
  await user.type(
    await view.findByLabelText("Agent address"),
    "https://agent.example.com/ag-ui",
  );
  return { view, user };
}

/** Long enough for a request the press started to have reached `fetch`. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

test("opens on where it runs, with Run it here already chosen", async () => {
  const { view } = await opened();
  const runHere = view.getByRole("button", { name: /Run it here/ });
  expect(runHere.getAttribute("aria-pressed")).toBe("true");
  expect(
    view.getByRole("button", { name: "Continue" }).hasAttribute("disabled"),
  ).toBe(false);
});

test("lists the partners people look for first, and never offers Mastra", async () => {
  const { view } = await opened();
  const frameworks = view
    .getAllByRole("button", { pressed: false })
    .map((button) => button.textContent ?? "");
  expect(frameworks.slice(0, 4)).toEqual([
    expect.stringContaining("Claude Agent SDK"),
    expect.stringContaining("Google ADK"),
    expect.stringContaining("Google Antigravity"),
    expect.stringContaining("LangGraph"),
  ]);
  expect(view.queryByRole("button", { name: /Mastra/ })).toBeNull();
});

test("chooses nothing where the deployment has no Bot of its own", async () => {
  builtInAvailable = false;
  const { view } = await opened();
  await settle();
  const runHere = view.getByRole("button", { name: /Run it here/ });
  expect(runHere.hasAttribute("disabled")).toBe(true);
  expect(runHere.getAttribute("aria-pressed")).toBe("false");
  expect(runHere.textContent).toContain("An admin has to turn this on");
  expect(
    view.getByRole("button", { name: "Continue" }).hasAttribute("disabled"),
  ).toBe(true);
});

test("Run it here goes straight to the name, and Create waits for one", async () => {
  const { view, user } = await opened();
  await user.click(view.getByRole("button", { name: "Continue" }));
  const name = await view.findByLabelText("Name");
  // Its instructions are the prompt it runs on, so the field is named for that.
  expect(view.getByLabelText(/^Instructions/)).toBeTruthy();
  const create = view.getByRole("button", { name: "Create" });
  expect(create.hasAttribute("disabled")).toBe(true);
  await user.type(name, "Expense Review");
  expect(create.hasAttribute("disabled")).toBe(false);
  expect(dialled).toEqual([]);
});

test("Create fills in what was left blank, then hands over", async () => {
  const handedOver: string[] = [];
  const { view, user } = await opened((id) => handedOver.push(id));
  await user.click(view.getByRole("button", { name: "Continue" }));
  const name = await view.findByLabelText("Name");
  await user.type(name, "Expense Review");
  // Enter in the name is Create.
  await act(async () => {
    fireEvent.keyDown(name, { key: "Enter", keyCode: 13 });
  });

  expect(await view.findByText("Expense Review is ready")).toBeTruthy();
  expect(creates).toHaveLength(1);
  expect(creates[0]).toMatchObject({
    name: "Expense Review",
    title: "Assistant",
    visibility: "private",
    endpoint: "",
  });
  // For a Bot that runs here this is its system prompt, so it has to be something it can act on.
  expect(String(creates[0]?.roleDescription)).toStartWith(
    "You are Expense Review.",
  );

  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1800));
  });
  expect(handedOver).toEqual(["agent_new"]);
});

test("a framework asks for its address, and refuses an empty one without dialling it", async () => {
  const { view, user } = await opened();
  await user.click(view.getByRole("button", { name: /LangGraph/ }));
  await user.click(view.getByRole("button", { name: "Continue" }));
  await view.findByText("Where can it be reached?");

  await user.click(view.getByRole("button", { name: "Continue" }));
  expect(await view.findByText("Enter your agent's address.")).toBeTruthy();
  expect(dialled).toEqual([]);
});

test("an address that does not answer says why under it, and goes no further", async () => {
  verdict = { ok: false, reason: "Nothing answered at that address." };
  const { view } = await connected();
  // Enter in the address is Continue, as it is everywhere else.
  await act(async () => {
    fireEvent.keyDown(view.getByLabelText("Agent address"), {
      key: "Enter",
      keyCode: 13,
    });
  });

  expect(
    await view.findByText("Nothing answered at that address."),
  ).toBeTruthy();
  expect(dialled).toEqual(["https://agent.example.com/ag-ui"]);
  expect(view.queryByLabelText("Name")).toBeNull();
  expect(creates).toEqual([]);
});

test("an address that answers moves on, and Create sends it with its key", async () => {
  const { view, user } = await connected();
  await user.type(view.getByLabelText(/Key/), "Bearer secret");
  await user.click(view.getByRole("button", { name: "Continue" }));

  await user.type(await view.findByLabelText("Name"), "Expense Review");
  // Somebody else's agent has its own prompt; what is typed here is added to it.
  expect(view.getByLabelText(/^Role/)).toBeTruthy();
  expect(creates).toEqual([]);
  await user.click(view.getByRole("button", { name: "Create" }));

  expect(await view.findByText("Expense Review is ready")).toBeTruthy();
  expect(creates).toHaveLength(1);
  expect(creates[0]).toMatchObject({
    endpoint: "https://agent.example.com/ag-ui",
    auth: { header: "Authorization", value: "Bearer secret" },
    title: "LangGraph",
    roleDescription: "Connected from LangGraph.",
  });
});

test("going back keeps what was answered, and Run it here leaves a typed address behind", async () => {
  const { view, user } = await connected();
  await user.click(view.getByRole("button", { name: "Continue" }));
  await user.type(await view.findByLabelText("Name"), "Expense Review");
  await user.click(view.getByRole("button", { name: /Public/ }));

  // Back from the name returns to the address, still filled in, then to the framework, still chosen.
  await user.click(view.getByRole("button", { name: "Back" }));
  expect(
    ((await view.findByLabelText("Agent address")) as HTMLInputElement).value,
  ).toBe("https://agent.example.com/ag-ui");
  await user.click(view.getByRole("button", { name: "Back" }));
  expect(
    (await view.findByRole("button", { name: /LangGraph/ })).getAttribute(
      "aria-pressed",
    ),
  ).toBe("true");

  await user.click(view.getByRole("button", { name: /Run it here/ }));
  await user.click(view.getByRole("button", { name: "Continue" }));
  expect(((await view.findByLabelText("Name")) as HTMLInputElement).value).toBe(
    "Expense Review",
  );
  await user.click(view.getByRole("button", { name: "Create" }));
  await view.findByText("Expense Review is ready");
  expect(creates[0]).toMatchObject({ endpoint: "", visibility: "public" });
  expect(creates[0]).not.toHaveProperty("auth");
});
