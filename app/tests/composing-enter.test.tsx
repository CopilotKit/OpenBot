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
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentType, ReactNode } from "react";
import { NewBotSheet } from "@/components/agents/new-bot-sheet";
import { SetupSections } from "@/components/bot-profile/setup";
import { type AgentProfile, agentKeys } from "@/lib/agents/queries";
import { computerKeys } from "@/lib/computers/queries";
import { Route as NewRuleRoute } from "@/routes/_authed/admin/boundaries_.new";

/**
 * The Enter that confirms a character an input method is composing is not an Enter.
 *
 * Japanese, Chinese and Korean are typed through an input method (IME), and Enter is how the
 * character being built is confirmed. That press still arrives as a keydown with `key === "Enter"`.
 * Chromium marks it `isComposing`, and WebKit sends it after `compositionend` with the key code 229.
 * The chat composer already skips it: `prompt-area` checks `isComposing` on every Enter it handles.
 * Three text fields in the app acted on it instead, each with a text field's text still unconfirmed:
 * a coworker's name saved in place, the New Bot sheet moving on to its next step, and a
 * boundary rule saved into the policy in force.
 *
 * THE HARNESS IS THIS REPOSITORY'S: `GlobalRegistrator` in `beforeAll`/`afterAll`, `cleanup` in
 * `afterEach`, queries off `render()`'s own return, and a `QueryClient` with `retry: false`. Each
 * screen is its real component, drawn inside a router of one route rather than through its own
 * route singleton, so nothing here is left pointing another file's router at a decoy.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const originalFetch = global.fetch;

/** Every write a screen sent, as `METHOD path`, so "nothing was saved" is an assertion. */
let writes: { request: string; body: unknown }[] = [];

const PROFILE: AgentProfile = {
  id: "expenses",
  name: "Expenses",
  title: "Finance Operations",
  roleDescription: "Review receipts.",
  avatarSeed: "expenses",
  visibility: "private",
  endpoint: null,
  builtIn: true,
  hasAuth: false,
  hasCallbackToken: false,
  isolated: false,
  isolationActive: false,
  isolationOffReason: null,
  hidden: false,
  pinned: false,
  systemOwned: false,
  canManage: true,
  mine: true,
};

const POLICY = { mode: "enforce", deny: [], allow: [] };

beforeEach(() => {
  writes = [];
  global.fetch = Object.assign(
    async (
      path: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const method = init?.method ?? "GET";
      const body =
        typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      if (method !== "GET") writes.push({ request: `${method} ${path}`, body });
      const json = (value: unknown) => Response.json(value);
      if (path === "/api/computers/policy") {
        return json({ policy: method === "PUT" ? body : POLICY });
      }
      if (path === "/api/agents/capabilities") {
        return json({ capabilities: { builtInAvailable: true } });
      }
      if (path === `/api/agents/${PROFILE.id}`) {
        return json({ agent: method === "PATCH" ? PROFILE : PROFILE });
      }
      return new Response(null, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});

afterEach(() => {
  global.fetch = originalFetch;
});

/** A screen drawn inside a router of one route, for the `Link` and `useNavigate` it holds. */
function draw(screen: ReactNode, seed?: (client: QueryClient) => void) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  seed?.(queryClient);
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

/** Both shapes the confirming Enter arrives in: Chromium's, then WebKit's. */
async function confirmComposedCharacter(field: Element) {
  await act(async () => {
    fireEvent.keyDown(field, { key: "Enter", isComposing: true });
    fireEvent.keyDown(field, { key: "Enter", keyCode: 229 });
  });
}

/** A person replacing what a field holds, one key at a time. */
async function type(field: Element, value: string) {
  const user = userEvent.setup({ document: field.ownerDocument });
  await user.clear(field);
  await user.type(field, value);
}

/** Long enough for a write the keydown started to have reached `fetch`. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

test("a coworker's name is not saved by the Enter that confirms a composed character", async () => {
  const view = draw(<SetupSections agent={PROFILE} />, (client) =>
    client.setQueryData(agentKeys.detail(PROFILE.id), PROFILE),
  );

  fireEvent.click(await view.findByRole("button", { name: /^Name/ }));
  const field = await view.findByDisplayValue(PROFILE.name);
  await type(field, "経費");

  await confirmComposedCharacter(field);
  await settle();
  expect(writes).toEqual([]);
  expect(view.getByDisplayValue("経費")).toBeTruthy();

  // An ordinary Enter still saves, once.
  await act(async () => {
    fireEvent.keyDown(field, { key: "Enter", keyCode: 13 });
  });
  await settle();
  expect(writes.map((write) => write.request)).toEqual([
    `PATCH /api/agents/${PROFILE.id}`,
  ]);
  expect(writes[0]?.body).toMatchObject({ name: "経費" });
});

test("the New Bot sheet does not create from the Enter that confirms a composed character", async () => {
  const view = draw(
    <NewBotSheet onClose={() => {}} onCreated={() => {}} open />,
  );

  // The details screen opens first, with Run here selected by default.
  const name = await view.findByLabelText("Name");
  await type(name, "経費");

  await confirmComposedCharacter(name);
  await settle();
  expect(writes.map((write) => write.request)).toEqual([]);

  // An ordinary Enter still means Create.
  await act(async () => {
    fireEvent.keyDown(name, { key: "Enter", keyCode: 13 });
  });
  await settle();
  expect(writes.map((write) => write.request)).toEqual(["POST /api/agents"]);
});

test("a boundary rule is not added by the Enter that confirms a composed character", async () => {
  const NewRule = NewRuleRoute.options.component as ComponentType;
  const view = draw(<NewRule />, (client) =>
    client.setQueryData(computerKeys.policy(), POLICY),
  );

  fireEvent.click(await view.findByText("Write your own"));
  const field = await view.findByLabelText("Rule");
  expect(field.getAttribute("spellcheck")).toBe("false");
  expect(field.getAttribute("autocorrect")).toBe("off");
  expect(field.getAttribute("autocapitalize")).toBe("off");
  const rule = 'contains(element.name, "送信")';
  await type(field, rule);
  const name = view.getByLabelText("Name");
  await type(name, "送信しない");

  // The composing Enter is held back from the form; an ordinary one is left to submit it.
  expect(fireEvent.keyDown(name, { key: "Enter", isComposing: true })).toBe(
    false,
  );
  expect(fireEvent.keyDown(name, { key: "Enter", keyCode: 229 })).toBe(false);
  expect(fireEvent.keyDown(name, { key: "Enter", keyCode: 13 })).toBe(true);
  await settle();
  expect(writes).toEqual([]);

  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Add rule" }));
  });
  await settle();
  expect(writes).toEqual([
    {
      request: "PUT /api/computers/policy",
      body: {
        ...POLICY,
        deny: [rule],
        labels: { [rule]: { name: "送信しない", description: "" } },
      },
    },
  ]);
});
