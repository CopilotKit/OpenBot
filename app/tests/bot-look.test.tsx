import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import { SetupSections } from "@/components/bot-profile/setup";
import { ChannelAvatar } from "@/components/channels/avatar";
import { agentListQueryOptions, agentQueryOptions } from "@/lib/agents/queries";
import { queryClient } from "@/query-client";
import {
  AgentNotManageableError,
  type AgentProfileStore,
} from "../../server/src/agents/profile-store";
import type { AgentProfile } from "../../server/src/agents/profile-types";
import { createAgentRoutes } from "../../server/src/agents/routes";
import { settleReactWork } from "./settle-react-work";

/**
 * Choosing how a Bot looks, from the Look section of its Setup page.
 *
 * The routes are the server's own, mounted behind `fetch` as `bot-setup.test.tsx` mounts them, so a
 * refused look is refused by the real check. The page is drawn with the app's own query client, so
 * a save's invalidation reaches every other avatar of the Bot on the page, as it does in the app:
 * the conversation list's, which knows only the Bot's id, and the Bots list's.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(() => {
  cleanup();
  queryClient.clear();
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const actor = {
  id: "owner",
  email: "owner@example.test",
  role: "user" as const,
};

/** Every update the store was asked to make, as the route parsed it. */
let updates: Record<string, unknown>[] = [];
/**
 * While true, each save waits at the door until the test lets it through, one at a time, so what
 * shows before the server answers can be seen, and two saves can settle in either order.
 */
let holding = false;
const waiting: (() => void)[] = [];

/** Lets the oldest held save reach the server, once it has been sent. */
async function letOneThrough() {
  await waitFor(() => expect(waiting.length).toBeGreaterThan(0));
  waiting.shift()?.();
}

beforeEach(() => {
  updates = [];
  holding = false;
  waiting.length = 0;
});

/** "expenses" hashes to ocean, which the Look section calls Blue. */
function serve({
  ownerUserId = actor.id,
  refuse = false,
  avatarSeed = "expenses",
  list = Promise.resolve(),
}: {
  ownerUserId?: string;
  refuse?: boolean;
  avatarSeed?: string;
  /** What the Bots list waits for before it answers. */
  list?: Promise<void>;
} = {}) {
  let profile: AgentProfile = {
    id: "expenses",
    name: "Expenses",
    title: "Finance Operations",
    roleDescription: "Review receipts.",
    avatarSeed,
    ownerUserId,
    visibility: "private",
    systemOwned: false,
    hidden: false,
    pinned: false,
    deletedAt: null,
    endpoint: "http://localhost:4201/ag-ui",
    hasAuth: false,
    hasCallbackToken: false,
    isolated: false,
  };
  const store = {
    get: async () => profile,
    list: async () => [profile],
    update: async (_actor: unknown, id: string, value: object) => {
      updates.push({ ...value });
      if (refuse) throw new AgentNotManageableError(id);
      const { endpoint: _endpoint, ...rest } = value as { endpoint?: string };
      profile = { ...profile, ...rest };
      return profile;
    },
  } as unknown as AgentProfileStore;
  const auth: Parameters<typeof createAgentRoutes>[1] = async (
    context,
    next,
  ) => {
    context.set("actor", actor);
    await next();
  };
  const routes = createAgentRoutes(
    store,
    auth,
    false,
    undefined,
    new Set(),
    undefined,
    true,
    "http://localhost:4201/ag-ui",
    undefined,
    undefined,
    { available: true },
  );
  globalThis.fetch = Object.assign(
    async (
      path: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      if (path === "/api/admin/enterprise/me") {
        return Response.json({
          capabilities: { isolatedComputers: true },
          enforced: true,
        });
      }
      if (typeof path !== "string" || !path.startsWith("/api/agents")) {
        throw new Error(`unexpected ${String(path)}`);
      }
      if (init?.method === "PATCH" && holding) {
        await new Promise<void>((resolve) => waiting.push(resolve));
      }
      if (path === "/api/agents") await list;
      return routes.request(
        new Request(
          `http://openbot.test${path.slice("/api/agents".length) || "/"}`,
          init,
        ),
      );
    },
    { preconnect: originalFetch.preconnect },
  );
}

/** The Setup page's sections, and two other places the same Bot's face is drawn. */
function Page() {
  const agent = useQuery(agentQueryOptions("expenses"));
  const roster = useQuery(agentListQueryOptions());
  return (
    <>
      {agent.data ? <SetupSections agent={agent.data} /> : null}
      <div data-testid="elsewhere">
        <ChannelAvatar participantIds={["expenses"]} />
        {roster.data?.map((bot) => (
          <AbstractAvatar key={bot.id} name={bot.name} seed={bot.avatarSeed} />
        ))}
      </div>
    </>
  );
}

function draw() {
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({ component: Page }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  const user = userEvent.setup({ document: view.baseElement.ownerDocument });
  return { view, user };
}

/** The Look section, once the Bot has loaded. */
async function lookOf(view: ReturnType<typeof render>) {
  const heading = await view.findByRole("heading", { name: "Look" });
  const section = heading.closest("section");
  if (!section) throw new Error("The Look heading is not in a section.");
  return within(section);
}

/** The seeds the face is drawn from, in the Look section and everywhere else on the page. */
function seeds(view: ReturnType<typeof render>) {
  const of = (root: Element) =>
    [...root.querySelectorAll("[data-seed]")].map((orb) =>
      orb.getAttribute("data-seed"),
    );
  const section = view
    .getByRole("heading", { name: "Look" })
    .closest("section");
  return {
    preview: section ? of(section) : [],
    elsewhere: of(view.getByTestId("elsewhere")),
  };
}

const COLOURS = [
  "Orange",
  "Green",
  "Yellow",
  "Pink",
  "Blue",
  "Light blue",
  "Coral",
  "Grey",
];

test("the Look section shows the Bot's face large, and its colour named and chosen", async () => {
  serve();
  const { view } = draw();
  const look = await lookOf(view);

  expect(
    look.getByText(
      "Pick a colour, or draw a new face. It shows wherever this Bot appears.",
    ),
  ).toBeTruthy();
  const group = look.getByRole("radiogroup", { name: "Colour" });
  const radios = within(group).getAllByRole("radio") as HTMLInputElement[];
  expect(radios.map((radio) => radio.getAttribute("aria-label"))).toEqual(
    COLOURS,
  );
  expect(radios.filter((radio) => radio.checked).map((r) => r.value)).toEqual([
    "ocean",
  ]);
  expect(look.getByText("Blue")).toBeTruthy();
  expect(look.getByRole("button", { name: "New face" })).toBeTruthy();

  const preview = look.getByRole("img", { name: "Expenses" });
  expect(preview.style.width).toBe("72px");
  expect(seeds(view).preview).toEqual(["expenses"]);
});

test("a colour saves at once, shows at once, and every avatar of the Bot follows", async () => {
  serve();
  holding = true;
  const { view, user } = draw();
  const look = await lookOf(view);
  await waitFor(() =>
    expect(seeds(view).elsewhere).toEqual(["expenses", "expenses"]),
  );

  await user.click(look.getByRole("radio", { name: "Green" }));

  // The face shows it before the server has answered, and nothing else has changed yet.
  expect(seeds(view)).toEqual({
    preview: ["moss:expenses"],
    elsewhere: ["expenses", "expenses"],
  });
  expect(
    (look.getByRole("radio", { name: "Green" }) as HTMLInputElement).checked,
  ).toBe(true);
  expect(look.getByText("Green")).toBeTruthy();

  await letOneThrough();
  await waitFor(() =>
    expect(seeds(view).elsewhere).toEqual(["moss:expenses", "moss:expenses"]),
  );
  expect(seeds(view).preview).toEqual(["moss:expenses"]);
  // The rest of the profile rode along as stored, and only the look changed.
  expect(updates).toEqual([
    {
      name: "Expenses",
      title: "Finance Operations",
      roleDescription: "Review receipts.",
      visibility: "private",
      avatarSeed: "moss:expenses",
    },
  ]);
  expect(view.queryByRole("alert")).toBeNull();
});

test("New face keeps the colour and draws a face nobody had", async () => {
  serve();
  const { view, user } = draw();
  const look = await lookOf(view);

  await user.click(look.getByRole("button", { name: "New face" }));

  await waitFor(() => expect(updates).toHaveLength(1));
  const face = String(updates[0]?.avatarSeed);
  expect(face).toMatch(/^ocean:[a-z0-9]{8}$/);
  await waitFor(() => expect(seeds(view).elsewhere).toEqual([face, face]));
  expect(seeds(view).preview).toEqual([face]);
  expect(look.getByText("Blue")).toBeTruthy();

  await user.click(look.getByRole("button", { name: "New face" }));
  await waitFor(() => expect(updates).toHaveLength(2));
  expect(updates[1]?.avatarSeed).not.toBe(face);
  expect(String(updates[1]?.avatarSeed)).toMatch(/^ocean:/);
});

test("the arrow keys move through the colours, as in any radio group, and the newest choice wins", async () => {
  serve();
  holding = true;
  const { view, user } = draw();
  const look = await lookOf(view);
  const radio = (name: string) =>
    look.getByRole("radio", { name }) as HTMLInputElement;

  radio("Blue").focus();
  await user.keyboard("{ArrowRight}");
  expect(document.activeElement).toBe(radio("Light blue"));
  expect(radio("Light blue").checked).toBe(true);

  // Still live while that one saves, so the next arrow carries on from where focus is.
  await user.keyboard("{ArrowRight}");
  expect(document.activeElement).toBe(radio("Coral"));
  expect(radio("Coral").checked).toBe(true);
  expect(seeds(view).preview).toEqual(["coral:expenses"]);

  // The first saves and the Bot is refetched with it; the face keeps the newer choice.
  await letOneThrough();
  await waitFor(() =>
    expect(seeds(view).elsewhere).toEqual(["sky:expenses", "sky:expenses"]),
  );
  expect(seeds(view).preview).toEqual(["coral:expenses"]);
  expect(radio("Coral").checked).toBe(true);

  await letOneThrough();
  await waitFor(() =>
    expect(seeds(view).elsewhere).toEqual(["coral:expenses", "coral:expenses"]),
  );
  expect(updates.map((update) => update.avatarSeed)).toEqual([
    "sky:expenses",
    "coral:expenses",
  ]);
  expect(seeds(view).preview).toEqual(["coral:expenses"]);
  expect(radio("Coral").checked).toBe(true);
});

test("a look that can't be saved goes back, and says so in one sentence", async () => {
  serve({ refuse: true });
  const { view, user } = draw();
  const look = await lookOf(view);

  await user.click(look.getByRole("radio", { name: "Pink" }));

  expect((await look.findByRole("alert")).textContent).toBe(
    "Couldn't save that look, so the last one is back.",
  );
  expect(seeds(view)).toEqual({
    preview: ["expenses"],
    elsewhere: ["expenses", "expenses"],
  });
  expect(
    (look.getByRole("radio", { name: "Blue" }) as HTMLInputElement).checked,
  ).toBe(true);
  expect(look.getByText("Blue")).toBeTruthy();

  // The next choice takes the sentence away while it saves.
  holding = true;
  await user.click(look.getByRole("radio", { name: "Green" }));
  expect(look.queryByRole("alert")).toBeNull();
  await letOneThrough();
  expect(await look.findByRole("alert")).toBeTruthy();
  expect(updates).toHaveLength(2);
});

test("someone who can't edit the Bot doesn't see the Look section", async () => {
  serve({ ownerUserId: "someone-else" });
  const { view } = draw();

  expect(await view.findByText("Finance Operations")).toBeTruthy();
  expect(view.queryByRole("heading", { name: "Look" })).toBeNull();
  expect(view.queryByRole("radiogroup")).toBeNull();
  expect(view.queryByRole("button", { name: "New face" })).toBeNull();
});

test("a conversation's face, which knows only the Bot's id, waits for the Bots list and draws the chosen look", async () => {
  let answer = () => {};
  serve({
    avatarSeed: "coral:k2p9x7aq",
    list: new Promise((resolve) => {
      answer = resolve;
    }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <ChannelAvatar participantIds={["expenses"]} />
      <ChannelAvatar participantIds={["expenses", "not-listed"]} />
    </QueryClientProvider>,
  );
  const drawn = () =>
    [...view.container.querySelectorAll("[data-seed]")].map((orb) =>
      orb.getAttribute("data-seed"),
    );

  // No face while the list loads, rather than the id's face and then another.
  await settleReactWork();
  expect(drawn()).toEqual([]);

  answer();
  // A Bot the list doesn't hold keeps the face of its id.
  await waitFor(() =>
    expect(drawn()).toEqual(["coral:k2p9x7aq", "coral:k2p9x7aq", "not-listed"]),
  );
});
