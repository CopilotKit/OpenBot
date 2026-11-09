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
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PolicyTranslation } from "@/lib/computers/policy-translate";
import type { ActionPolicy } from "@/lib/computers/queries";
import { Route as BoundariesRoute } from "@/routes/_authed/admin/boundaries";
import { Route as RuleRoute } from "@/routes/_authed/admin/boundaries_.$index";
import { Route as NewRuleRoute } from "@/routes/_authed/admin/boundaries_.new";

/**
 * A boundary described in English: the model's rule lands in the CEL field beside its independent
 * reading and the compile result, an edit after that is called out, and only the admin's own Save
 * saves it, carrying the description with it. The server is a fake that answers as the real one does.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 50));
  await GlobalRegistrator.unregister();
});

type Routed = { options: object };
const routes = [
  BoundariesRoute,
  NewRuleRoute,
  RuleRoute,
] as unknown as Routed[];
const pristine = routes.map((route) => ({
  ...route,
  options: { ...route.options },
}));
beforeEach(() => {
  routes.forEach((route, index) => {
    for (const key of Object.keys(route))
      if (!(key in pristine[index]!))
        delete (route as Record<string, unknown>)[key];
    Object.assign(route, pristine[index], {
      options: { ...pristine[index]!.options },
    });
  });
});

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

/** What the real endpoint answered for this description (server/tests/fixtures). */
const SOCIAL: PolicyTranslation = {
  rule: 'intent == "navigate" && (page.host == "facebook.com" || matches(page.host, "[.]facebook[.]com$"))',
  effect: "deny",
  summary: "Stops a Bot opening Facebook.",
  explanation:
    "Stops a Bot from navigating to facebook.com, including its subdomains.",
  compile: { ok: true },
  warning: null,
};

let stored: ActionPolicy;
let translation: PolicyTranslation | { error: string; status: number };
const saved: Record<string, unknown>[] = [];
const described: string[] = [];
const replayed: ActionPolicy[] = [];
function serving(policy: ActionPolicy) {
  stored = policy;
  saved.length = 0;
  described.length = 0;
  replayed.length = 0;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith("/api/computers/policy") && init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      saved.push(body);
      const { authoring: _authoring, ...policy } = body;
      stored = policy as ActionPolicy;
      return Response.json({ policy: stored });
    }
    if (path.endsWith("/api/computers/policy"))
      return Response.json({ policy: stored });
    if (path.endsWith("/api/computers/policy-translate")) {
      described.push(JSON.parse(String(init?.body)).text);
      return "status" in translation
        ? Response.json(
            { error: translation.error },
            { status: translation.status },
          )
        : Response.json(translation);
    }
    if (path.endsWith("/api/computers/policy-dry-run")) {
      replayed.push(JSON.parse(String(init?.body)).policy);
      return Response.json({
        report: {
          scanned: 3,
          wouldRefuse: 1,
          wouldAllow: 0,
          unchanged: 2,
          changes: [
            {
              id: "e1",
              createdAt: "2026-11-09T18:00:00.000Z",
              kind: "computer",
              initiator: { kind: "person", id: "" },
              action: "computer_navigate",
              bot: "research-assistant",
              page: "https://www.facebook.com/groups/x",
              element: null,
              command: null,
              file: null,
              was: "allowed",
              would: "refused",
              rule: SOCIAL.rule,
              reason: "blocked",
            },
          ],
        },
      });
    }
    if (path.includes("/api/agents"))
      return Response.json({
        agents: [{ id: "research-assistant", name: "Research Assistant" }],
      });
    return Response.json({ error: "unexpected" }, { status: 404 });
  }) as typeof fetch;
}

function open(path: string) {
  const root = createRootRoute({ component: Outlet });
  const authed = createRoute({
    id: "/_authed",
    getParentRoute: () => root,
    component: Outlet,
  });
  const admin = createRoute({
    path: "/admin",
    getParentRoute: () => authed,
    component: Outlet,
  });
  const wire = (route: unknown, id: string, at: string) =>
    (route as { update: (options: unknown) => never }).update({
      id,
      path: at,
      getParentRoute: () => admin,
    });
  const audit = createRoute({
    path: "/audit",
    getParentRoute: () => admin,
    component: () => null,
  });
  const router = createRouter({
    routeTree: root.addChildren([
      authed.addChildren([
        admin.addChildren([
          wire(BoundariesRoute, "/boundaries", "/boundaries"),
          wire(NewRuleRoute, "/boundaries_/new", "/boundaries/new"),
          wire(RuleRoute, "/boundaries_/$index", "/boundaries/$index"),
          audit,
        ]),
      ]),
    ]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  const view = render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return { view, router };
}

/** Typed as a person types it, so the field's own state sees every keystroke. */
async function describeRule(view: ReturnType<typeof render>, text: string) {
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.type(await view.findByLabelText("Describe the rule"), text);
  await user.click(view.getByRole("button", { name: "Write rule" }));
}

test("a description fills the rule, shows its reading and compile result, replays it, and Add saves it with the description", async () => {
  serving({ mode: "enforce", deny: [], allow: ["true"] });
  translation = SOCIAL;
  const { view, router } = open("/admin/boundaries/new");

  fireEvent.click(await view.findByText("Describe it in words"));
  await describeRule(view, "Bots may not visit social media sites");

  expect(await view.findByText(SOCIAL.explanation as string)).toBeTruthy();
  expect(described).toEqual(["Bots may not visit social media sites"]);
  expect((view.getByLabelText("Rule") as HTMLTextAreaElement).value).toBe(
    SOCIAL.rule,
  );
  expect(
    view.getByText("Compiles. OpenBot can check it on every action."),
  ).toBeTruthy();
  // Replayed as soon as it rests in the field, on its own.
  expect(
    await view.findByText(
      "Of the last 3 recorded actions, this rule would have stopped 1.",
    ),
  ).toBeTruthy();
  expect(replayed).toEqual([
    { mode: "enforce", deny: [SOCIAL.rule], allow: ["true"] },
  ]);
  // Nothing is saved until the admin adds it.
  expect(saved).toHaveLength(0);

  fireEvent.click(view.getByRole("button", { name: "Add rule" }));
  await waitFor(() => expect(saved).toHaveLength(1));
  expect(saved[0]).toEqual({
    mode: "enforce",
    deny: [SOCIAL.rule],
    allow: ["true"],
    labels: {
      [SOCIAL.rule]: {
        name: "Bots may not visit social media sites",
        description: "Stops a Bot opening Facebook.",
      },
    },
    authoring: {
      source: "english",
      text: "Bots may not visit social media sites",
    },
  });
  await waitFor(() =>
    expect(router.state.location.pathname).toBe("/admin/boundaries"),
  );
});

test("editing the written rule by hand is allowed and called out", async () => {
  serving({ mode: "enforce", deny: [], allow: ["true"] });
  translation = SOCIAL;
  const { view } = open("/admin/boundaries/new");

  fireEvent.click(await view.findByText("Describe it in words"));
  await describeRule(view, "Bots may not visit social media sites");
  await view.findByText(SOCIAL.explanation as string);
  expect(view.queryByText(/You've changed the rule/)).toBeNull();

  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.type(view.getByLabelText("Rule"), ' || page.host == "bsky.app"');

  expect(
    view.getByText(
      "You've changed the rule since it was written. The check and the reading above are for the written rule, not your edit.",
    ),
  ).toBeTruthy();
  expect(
    (view.getByRole("button", { name: "Add rule" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
});

test("What it stops is filled from the reading when empty, and what the admin typed there is kept", async () => {
  serving({ mode: "enforce", deny: [], allow: ["true"] });
  translation = SOCIAL;
  const { view } = open("/admin/boundaries/new");
  const user = userEvent.setup({ document: view.container.ownerDocument });

  fireEvent.click(await view.findByText("Describe it in words"));
  await describeRule(view, "Bots may not visit social media sites");
  await view.findByText(SOCIAL.explanation as string);
  const stops = view.getByLabelText("What it stops") as HTMLInputElement;
  expect(stops.value).toBe("Stops a Bot opening Facebook.");

  // Written again, the field still holds only what the last rule put there, so it is replaced.
  translation = { ...SOCIAL, summary: "Stops a Bot opening Facebook or X." };
  await user.click(view.getByRole("button", { name: "Write rule" }));
  await waitFor(() =>
    expect(stops.value).toBe("Stops a Bot opening Facebook or X."),
  );

  // Once the admin writes their own, a new rule never overwrites it.
  await user.clear(stops);
  await user.type(stops, "Keeps Bots off social sites.");
  translation = { ...SOCIAL, summary: "Stops a Bot opening Reddit." };
  await user.click(view.getByRole("button", { name: "Write rule" }));
  await waitFor(() => expect(described).toHaveLength(3));
  // Back to "Write rule" once the answer has been taken in.
  await view.findByRole("button", { name: "Write rule" });
  expect((view.getByLabelText("Rule") as HTMLTextAreaElement).value).toBe(
    SOCIAL.rule,
  );
  expect(stops.value).toBe("Keeps Bots off social sites.");
});

test("a rule that never compiled is shown with the error and can't be added as written", async () => {
  serving({ mode: "enforce", deny: [], allow: ["true"] });
  translation = {
    rule: "intent == \"navigate\" && (page.url[page.url.indexOf('?') + 1:].length > 200)",
    effect: "deny",
    summary: null,
    explanation: null,
    compile: {
      ok: false,
      error:
        "Expecting token of type --> CloseBracket <-- but found --> ':' <--",
    },
    warning: null,
  };
  const { view } = open("/admin/boundaries/new");

  fireEvent.click(await view.findByText("Describe it in words"));
  await describeRule(
    view,
    "Block any URL with a query string longer than 200 characters",
  );

  expect(
    await view.findByText(/Doesn't compile, so OpenBot won't save it/),
  ).toBeTruthy();
  expect(view.queryByText("What this rule does")).toBeNull();
  expect(
    (view.getByRole("button", { name: "Add rule" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  // Nothing to replay: its error is already on screen. Waited past the preview's rest first.
  await new Promise((resolve) => setTimeout(resolve, 600));
  expect(replayed).toHaveLength(0);
});

test("a description that only grants permission is answered, not filled in", async () => {
  serving({ mode: "enforce", deny: [], allow: ["true"] });
  translation = {
    ...SOCIAL,
    effect: "allow",
    rule: 'contains(mcp.server, "gmail")',
  };
  const { view } = open("/admin/boundaries/new");

  fireEvent.click(await view.findByText("Describe it in words"));
  await describeRule(view, "Let Bots use Gmail");

  expect(
    await view.findByText(
      "That says what Bots may do. A rule here stops an action, so describe what no Bot may do.",
    ),
  ).toBeTruthy();
  expect((view.getByLabelText("Rule") as HTMLTextAreaElement).value).toBe("");
});

test("with no model set up, the server's sentence is shown and nothing is filled in", async () => {
  serving({ mode: "enforce", deny: [], allow: ["true"] });
  translation = {
    status: 503,
    error:
      "OpenBot needs a model key to write a rule from a description. Add one on the Credentials page, or write the rule in CEL.",
  };
  const { view } = open("/admin/boundaries/new");

  fireEvent.click(await view.findByText("Describe it in words"));
  await describeRule(view, "Bots may not visit social media sites");

  expect(
    await view.findByText(
      "OpenBot needs a model key to write a rule from a description. Add one on the Credentials page, or write the rule in CEL.",
    ),
  ).toBeTruthy();
  expect((view.getByLabelText("Rule") as HTMLTextAreaElement).value).toBe("");
});

test("on a rule's own page, a description rewrites it in place, keeps its name, and Save rule sends the description", async () => {
  const old = 'intent == "navigate" && contains(page.host, "facebook.com")';
  serving({
    mode: "enforce",
    deny: ["true", old],
    allow: ["true"],
    labels: {
      [old]: { name: "No Facebook", description: "Keeps Bots off it." },
    },
  });
  translation = SOCIAL;
  const { view } = open("/admin/boundaries/1");

  expect(
    ((await view.findByLabelText("Rule")) as HTMLTextAreaElement).value,
  ).toBe(old);
  expect(view.queryByRole("button", { name: "Save rule" })).toBeNull();

  await describeRule(view, "Bots may not visit social media sites");
  await view.findByText(SOCIAL.explanation as string);
  expect(
    await view.findByText(
      "Of the last 3 recorded actions, this rule would have stopped 1.",
    ),
  ).toBeTruthy();
  // The page's own "Recently stopped" first (the policy without this rule), then the new version
  // on its own, as Add rule replays a new rule.
  expect(replayed).toEqual([
    { mode: "enforce", deny: ["true"], allow: ["true"], labels: {} },
    { mode: "enforce", deny: [SOCIAL.rule], allow: ["true"] },
  ]);
  expect(saved).toHaveLength(0);

  fireEvent.click(view.getByRole("button", { name: "Save rule" }));
  await waitFor(() => expect(saved).toHaveLength(1));
  expect(saved[0]).toEqual({
    mode: "enforce",
    deny: ["true", SOCIAL.rule],
    allow: ["true"],
    labels: {
      [SOCIAL.rule]: { name: "No Facebook", description: "Keeps Bots off it." },
    },
    authoring: {
      source: "english",
      text: "Bots may not visit social media sites",
    },
  });
});
