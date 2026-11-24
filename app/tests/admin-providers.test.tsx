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
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { deploymentKeys } from "@/lib/deployment/queries";
import type { ModelSource } from "@/lib/models/queries";
import { queryClient } from "@/query-client";
import {
  capabilityPath,
  MODEL_USAGE_PATH,
  overviewResponse,
  SETTINGS_PATH,
} from "./admin-settings-api";
import { MODEL_CATALOGUE_PATH } from "./models-api";
import { settleReactWork } from "./settle-react-work";
import { vendoredMarkFor } from "./vendored-marks";

/*
 * Admin, Providers and Permissions: the pages Enterprise controls was split into. The server is
 * faked at the fetch boundary with the API's answers for the settings, the switches and model
 * usage, and the model catalogue's view of every model listed; the writes are the API's own. Marks resolve as the app
 * resolves them, from the files vendored in `shared/marks`.
 */
mock.module("@/lib/marks", () => ({ markFor: vendoredMarkFor }));

// After the stub: a static import is hoisted and would load the real marks module first.
const { allowedSummary } = await import(
  "@/components/admin/controls/model-sections"
);
const { Route: EnterpriseRoute } = await import(
  "@/routes/_authed/admin/enterprise"
);
const { PermissionsPage } = await import("@/routes/_authed/admin/permissions");
const { ProvidersPage } = await import("@/routes/_authed/admin/providers");

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

let settings: Record<string, unknown>;
/** Who serves the models; the allowlist prefix stays `openai` whatever this is. */
let source: ModelSource;
/** One person (`all`) or a team whose admin allows models (`allowed`). */
let exposure: "all" | "allowed";
/** The Usage section's rows, as `/models/usage` summarises them. */
let usage: {
  model: string;
  source: string;
  runs: number;
  people: number;
  refused: number;
  lastUsedAt: string;
}[] = [];
const writes: { path: string; body: unknown }[] = [];

function serving() {
  writes.length = 0;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if ((init?.method ?? "GET") === "PATCH") {
      const body = JSON.parse(String(init?.body));
      writes.push({ path, body });
      if (path === SETTINGS_PATH) settings = { ...settings, ...body };
      return Response.json({});
    }
    const overview = overviewResponse(path, {
      capabilities: [
        {
          capability: "useBots",
          title: "Use Bots",
          description: "Talk to Bots and let them run work.",
          default: true,
          organization: null,
          roles: {},
          groups: {},
        },
      ],
      settings,
      groups: [],
      network: [],
      defaultDestinations: [],
      mcpServers: [],
      builtInModel: "openai/gpt-5.6-terra",
      scim: {
        configured: false,
        connectionId: "directory",
        baseUrl: null,
        rotating: false,
      },
      otel: { configured: false },
      actionRecordRetentionDays: 90,
    });
    if (overview) return overview;
    if (path === `${MODEL_CATALOGUE_PATH}?view=all`)
      return Response.json({
        provider: "openai",
        source,
        exposure,
        default: "gpt-5.6-terra",
        listed: true,
        models: [
          {
            id: "gpt-6-sol",
            label: "GPT-6 Sol",
            vendor: "openai",
            efforts: ["low", "medium", "high"],
          },
          {
            id: "gpt-5.6-terra",
            label: "GPT-5.6 Terra",
            vendor: "openai",
            efforts: ["none", "low", "medium", "high", "xhigh"],
            defaultEffort: "medium",
          },
          { id: "gpt-4o", label: "GPT-4o", vendor: "openai" },
        ],
      });
    if (path.startsWith(MODEL_USAGE_PATH))
      return Response.json({ days: 30, summary: usage, recent: [] });
    return Response.json({ error: "not served" }, { status: 404 });
  }) as unknown as typeof fetch;
}

/** The team edition, as a server from before the edition switch reads. */
function seedTeamEdition() {
  queryClient.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    selfHostBanner: false,
    localEvaluation: false,
    edition: "team",
  });
}

beforeEach(() => {
  settings = {
    ssoRequired: false,
    actionRecording: false,
    inactiveComputerDays: 30,
    modelAllowlist: { enabled: true, models: ["openai/gpt-5.6-terra"] },
    mcpAllowlist: { enabled: false, servers: [] },
    skillSharing: false,
    proactiveDailyRuns: 24,
    modelSelection: false,
  };
  source = "openai";
  exposure = "allowed";
  usage = [];
  queryClient.clear();
  seedTeamEdition();
  serving();
});

async function draw(page: () => React.ReactNode) {
  const router = createRouter({
    routeTree: createRootRoute({ component: page }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

test("a team's admin allows the models people pick, with no separate switch", async () => {
  const view = await draw(ProvidersPage);
  expect(await view.findByText("OpenAI")).toBeTruthy();
  expect(
    await view.findByText("Default GPT-5.6 Terra · 3 models listed"),
  ).toBeTruthy();
  // What is allowed says it: one listed model allowed, and no on/off switch beside it.
  expect(await view.findByText("1 model allowed")).toBeTruthy();
  expect(
    view.queryByRole("switch", { name: "Let people choose a model" }),
  ).toBeNull();
  expect(view.getByRole("button", { name: /Allowed models/ })).toBeTruthy();
  expect(
    await view.findByText(
      "Runs on each model in the last 30 days, refused runs included.",
    ),
  ).toBeTruthy();
});

test("a team that hasn't narrowed the allowlist is told people pick every listed model", async () => {
  // Off with nothing allowed, as every organization starts, and on with nothing allowed yet:
  // an empty allowlist means every model, as the server offers and runs them.
  for (const [modelAllowlist, switchSays] of [
    [
      { enabled: false, models: [] },
      "Off. People can pick any listed model, and no run is refused for its model.",
    ],
    [
      { enabled: true, models: [] },
      "On, but no model is allowed yet, so every model stays open. Allow models below to narrow it.",
    ],
  ] as const) {
    settings = { ...settings, modelAllowlist };
    queryClient.clear();
    seedTeamEdition();
    const view = await draw(ProvidersPage);
    expect(await view.findByText("Every listed model")).toBeTruthy();
    expect(
      view.getByText("3 models, kept current from your provider."),
    ).toBeTruthy();
    expect(view.queryByText(/No models allowed yet/)).toBeNull();
    expect(view.queryByText(/don't see a model picker/)).toBeNull();
    // A team's admin can still narrow it.
    expect(
      view.getByRole("switch", { name: "Only allowed models" }),
    ).toBeTruthy();
    expect(view.getByText(switchSays)).toBeTruthy();
    view.unmount();
  }
});

test("a team whose allowed models aren't listed is told people only get the default", async () => {
  settings = {
    ...settings,
    modelAllowlist: { enabled: true, models: ["openai/gpt-retired"] },
  };
  const view = await draw(ProvidersPage);
  expect(await view.findByText("No allowed model is listed")).toBeTruthy();
  expect(
    view.getByText(
      "Your provider doesn't list any model you allowed, so people only get GPT-5.6 Terra.",
    ),
  ).toBeTruthy();
});

test("an allowlist that leaves out the default says Bots run on the newest model it allows", async () => {
  // The server never offers a model it would refuse: the newest allowed model is the default.
  settings = {
    ...settings,
    modelAllowlist: {
      enabled: true,
      models: ["openai/gpt-4o", "openai/gpt-6-sol"],
    },
  };
  const view = await draw(ProvidersPage);
  expect(
    await view.findByText(
      "People pick among the models you allow below, and their thinking level, in each conversation. Bots run on GPT-6 Sol until somebody picks another.",
    ),
  ).toBeTruthy();
});

test("one person on their own machine is offered every model, and nothing can narrow it", async () => {
  exposure = "all";
  const view = await draw(ProvidersPage);
  expect(await view.findByText("Every listed model")).toBeTruthy();
  expect(
    view.getByText("3 models, kept current from your provider."),
  ).toBeTruthy();
  // No allowlist and no switch to narrow it.
  expect(view.queryByRole("button", { name: /Allowed models/ })).toBeNull();
  expect(
    view.queryByRole("switch", { name: "Only allowed models" }),
  ).toBeNull();
  expect(
    view.queryByRole("switch", { name: "Let people choose a model" }),
  ).toBeNull();
  // Usage doesn't mention an allowlist one person doesn't have.
  expect(
    await view.findByText("Runs on each model in the last 30 days."),
  ).toBeTruthy();
  expect(view.queryByText(/refused runs included/)).toBeNull();
});

test("Usage says how each model is known, and why one is missing, never the server's bare words", async () => {
  // The Mac pass listed the picked harness as "remote:picked-harness · unknown".
  usage = [
    {
      model: "anthropic/claude-sonnet-5-5",
      source: "configured",
      runs: 8,
      people: 1,
      refused: 3,
      lastUsedAt: "2026-11-12T00:00:00.000Z",
    },
    {
      model: "remote:sales-agent",
      source: "unknown",
      runs: 2,
      people: 1,
      refused: 0,
      lastUsedAt: "2026-11-12T00:00:00.000Z",
    },
  ];
  const view = await draw(ProvidersPage);
  expect(await view.findByText("anthropic/claude-sonnet-5-5")).toBeTruthy();
  // In plain words: how many were refused, and that the model was set in OpenBot.
  expect(
    view.getByText(/8 runs by 1 person · 3 refused\s+· set in OpenBot/),
  ).toBeTruthy();
  expect(view.queryByText(/allowlist|chosen by OpenBot/)).toBeNull();
  expect(view.getByText("Model not reported")).toBeTruthy();
  expect(
    view.getByText(
      /2 runs by 1 person\s+· sales-agent picks its own model and didn't say which/,
    ),
  ).toBeTruthy();
  expect(view.queryByText("remote:sales-agent")).toBeNull();
  expect(view.queryByText(/· unknown$/)).toBeNull();
});

test("Providers names what actually serves the models, with a vendor's mark only where one is vendored", async () => {
  const cases: [ModelSource, string, string | null][] = [
    ["openai", "OpenAI", "OpenAI"],
    ["anthropic", "Anthropic", "Anthropic"],
    ["google", "Google", "Google"],
    ["xai", "xAI", "xAI"],
    ["gateway", "OpenAI-compatible endpoint", null],
    ["chatgpt", "ChatGPT plan", "ChatGPT plan"],
    ["claude", "Claude plan", "Claude plan"],
  ];
  for (const [served, name, mark] of cases) {
    source = served;
    queryClient.clear();
    seedTeamEdition();
    const view = await draw(ProvidersPage);
    const title = await view.findByText(name);
    const row = title.closest("[data-slot=item]") as HTMLElement;
    expect(row.querySelector("img[data-mark]")?.getAttribute("data-mark")).toBe(
      mark ?? undefined,
    );
    expect(row.textContent).toContain(
      "Default GPT-5.6 Terra · 3 models listed",
    );
    view.unmount();
  }
});

test("the allowlist names models by provider, whoever serves them", async () => {
  source = "gateway";
  const view = await draw(ProvidersPage);
  fireEvent.click(await view.findByRole("button", { name: /Allowed models/ }));
  await view.findByRole("dialog");
  // Listed by its name, saved by the provider's prefix whatever serves it.
  fireEvent.click(
    await view.findByRole("checkbox", { name: "Allow GPT-6 Sol" }),
  );
  fireEvent.click(view.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(writes).toContainEqual({
      path: SETTINGS_PATH,
      body: {
        modelAllowlist: {
          enabled: true,
          models: ["openai/gpt-5.6-terra", "openai/gpt-6-sol"],
        },
      },
    }),
  );
});

test("the allowlist is picked from the provider's models, and takes one it doesn't list by full name", async () => {
  const view = await draw(ProvidersPage);
  fireEvent.click(await view.findByRole("button", { name: /Allowed models/ }));
  const dialog = await view.findByRole("dialog");

  // Every listed model is offered by its name, with the deployment's own marked and how each
  // thinks. The id a run sends is nobody's to read here.
  await waitFor(() => expect(dialog.textContent).toContain("GPT-6 Sol"));
  expect(dialog.textContent).toContain(
    "GPT-5.6 TerraDefault · Thinking: None, Low, Medium, High, Extra high",
  );
  expect(dialog.textContent).toContain("GPT-6 SolThinking: Low, Medium, High");
  expect(dialog.textContent).not.toContain("openai/");
  // The maker's mark, as the composer's picker draws it.
  expect(dialog.querySelector('img[data-mark="GPT-6 Sol"]')).toBeTruthy();

  // Search narrows the list.
  const user = userEvent.setup({ document });
  const search = view.getByRole("textbox", { name: "Search models" });
  await user.type(search, "sol");
  await waitFor(() => expect(dialog.textContent).not.toContain("GPT-4o"));
  fireEvent.click(view.getByRole("checkbox", { name: "Allow GPT-6 Sol" }));
  await user.type(search, "{Backspace}{Backspace}{Backspace}");
  await waitFor(() => expect(dialog.textContent).toContain("GPT-4o"));

  // A model the listing doesn't have, by its full name only.
  const other = view.getByRole("textbox", { name: "Another model" });
  const add = view.getByRole("button", { name: "Add" });
  await user.type(other, "claude-opus-5-5");
  expect((add as HTMLButtonElement).disabled).toBe(true);
  await user.type(other, "{Home}anthropic/");
  await waitFor(() => expect((add as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(add);
  await waitFor(() =>
    expect(dialog.textContent).toContain("anthropic/claude-opus-5-5"),
  );

  fireEvent.click(view.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(writes).toContainEqual({
      path: SETTINGS_PATH,
      body: {
        modelAllowlist: {
          enabled: true,
          models: [
            "openai/gpt-5.6-terra",
            "openai/gpt-6-sol",
            "anthropic/claude-opus-5-5",
          ],
        },
      },
    }),
  );
});

test("leaving out the default says the newest allowed model takes its place, and a Bot set to it is refused", async () => {
  const note =
    "GPT-5.6 Terra is the default. While Only allowed models is on without it, the newest model you allow is the default instead. A Bot set to GPT-5.6 Terra is refused.";
  const view = await draw(ProvidersPage);
  fireEvent.click(await view.findByRole("button", { name: /Allowed models/ }));
  const dialog = await view.findByRole("dialog");
  await waitFor(() => expect(dialog.textContent).toContain("GPT-5.6 Terra"));
  expect(dialog.textContent).not.toContain(note);
  // Another allowed and the default taken off: the note says what happens.
  fireEvent.click(view.getByRole("checkbox", { name: "Allow GPT-6 Sol" }));
  fireEvent.click(view.getByRole("checkbox", { name: "Allow GPT-5.6 Terra" }));
  await waitFor(() => expect(dialog.textContent).toContain(note));
  // Nothing allowed narrows nothing: the default is untouched, so nothing is said.
  fireEvent.click(view.getByRole("checkbox", { name: "Allow GPT-6 Sol" }));
  await waitFor(() => expect(dialog.textContent).not.toContain(note));
});

test("Permissions holds the organization's switches", async () => {
  const view = await draw(PermissionsPage);
  fireEvent.click(await view.findByRole("switch", { name: "Use Bots" }));
  await waitFor(() =>
    expect(writes).toContainEqual({
      path: capabilityPath("useBots"),
      body: { organization: false },
    }),
  );
  expect(view.getByRole("button", { name: /Role and team overrides/ }));
});

test("the allowed-models row names the first few models, by their names", () => {
  const nameOf = (name: string) =>
    ({ "openai/a": "Model A", "openai/b": "Model B" })[name] ?? name;
  expect(allowedSummary([], nameOf)).toBe("None listed");
  expect(allowedSummary(["openai/a", "openai/b"], nameOf)).toBe(
    "Model A, Model B",
  );
  // A model no listing names keeps its id: it has no other name.
  expect(
    allowedSummary(
      ["openai/a", "openai/b", "openai/c", "openai/d", "x/e"],
      nameOf,
    ),
  ).toBe("Model A, Model B, openai/c and 2 more");
});

test("an old link to Enterprise controls opens the Admin overview", () => {
  let thrown: unknown;
  try {
    (EnterpriseRoute.options.beforeLoad as unknown as () => void)();
  } catch (error) {
    thrown = error;
  }
  expect(
    (thrown as { options?: { to?: string } } | undefined)?.options?.to,
  ).toBe("/admin");
});

test("cancelling allowlist edits restores the saved choices when reopened", async () => {
  const view = await draw(ProvidersPage);
  fireEvent.click(await view.findByRole("button", { name: /Allowed models/ }));
  fireEvent.click(
    await view.findByRole("checkbox", { name: "Allow GPT-6 Sol" }),
  );
  fireEvent.click(view.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
  fireEvent.click(view.getByRole("button", { name: /Allowed models/ }));
  const reopened = await view.findByRole("checkbox", {
    name: "Allow GPT-6 Sol",
  });
  expect(reopened.getAttribute("aria-checked")).toBe("false");
  fireEvent.click(view.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(writes).toContainEqual({
      path: SETTINGS_PATH,
      body: {
        modelAllowlist: { enabled: true, models: ["openai/gpt-5.6-terra"] },
      },
    }),
  );
});
