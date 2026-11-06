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
import type { ModelSource } from "@/lib/models/queries";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";
import { vendoredMarkFor } from "./vendored-marks";

/*
 * Admin, Providers and Permissions: the pages Enterprise controls was split into. The server is
 * faked at the fetch boundary with the shapes `GET /api/admin/enterprise` and
 * `GET /api/models/available` answer with, and the writes are the enterprise routes' own. Marks
 * resolve as the app resolves them, from the files vendored in `shared/marks`.
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
const writes: { path: string; body: unknown }[] = [];

function serving() {
  writes.length = 0;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if ((init?.method ?? "GET") === "PUT") {
      const body = JSON.parse(String(init?.body));
      writes.push({ path, body });
      const key = path.split("/").pop() as string;
      settings = { ...settings, [key]: body.value };
      return Response.json({ key, value: body.value });
    }
    if (path === "/api/admin/enterprise")
      return Response.json({
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
    if (path === "/api/models/available")
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
    if (path.startsWith("/api/admin/enterprise/models/usage"))
      return Response.json({ days: 30, summary: [], recent: [] });
    return Response.json({ error: "not served" }, { status: 404 });
  }) as unknown as typeof fetch;
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
  queryClient.clear();
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
    await view.findByText("Default gpt-5.6-terra · 3 models listed"),
  ).toBeTruthy();
  // What is allowed says it: one listed model allowed, and no on/off switch beside it.
  expect(await view.findByText("1 model allowed")).toBeTruthy();
  expect(
    view.queryByRole("switch", { name: "Let people choose a model" }),
  ).toBeNull();
  expect(view.getByRole("button", { name: /Allowed models/ })).toBeTruthy();
  expect(
    await view.findByText(
      "Runs on each model in the last 30 days, including runs the allowlist refused.",
    ),
  ).toBeTruthy();
});

test("a team with nothing allowed is told people see no picker until it allows one", async () => {
  settings = { ...settings, modelAllowlist: { enabled: false, models: [] } };
  const view = await draw(ProvidersPage);
  expect(await view.findByText("No models allowed yet")).toBeTruthy();
  expect(
    view.getByText(
      "People don't see a model picker. Allow models below to offer them.",
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
  expect(view.queryByText(/allowlist refused/)).toBeNull();
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
    const view = await draw(ProvidersPage);
    const title = await view.findByText(name);
    const row = title.closest("[data-slot=item]") as HTMLElement;
    expect(row.querySelector("img[data-mark]")?.getAttribute("data-mark")).toBe(
      mark ?? undefined,
    );
    expect(row.textContent).toContain(
      "Default gpt-5.6-terra · 3 models listed",
    );
    view.unmount();
  }
});

test("the allowlist names models by provider, whoever serves them", async () => {
  source = "gateway";
  const view = await draw(ProvidersPage);
  fireEvent.click(await view.findByRole("button", { name: /Allowed models/ }));
  const dialog = await view.findByRole("dialog");
  await waitFor(() => expect(dialog.textContent).toContain("openai/gpt-6-sol"));
});

test("the allowlist is picked from the provider's models, and takes one it doesn't list by full name", async () => {
  const view = await draw(ProvidersPage);
  fireEvent.click(await view.findByRole("button", { name: /Allowed models/ }));
  const dialog = await view.findByRole("dialog");

  // Every listed model is offered, with the deployment's own marked and how each thinks.
  await waitFor(() => expect(dialog.textContent).toContain("GPT-6 Sol"));
  expect(dialog.textContent).toContain("openai/gpt-5.6-terra · default");
  expect(dialog.textContent).toContain(
    "openai/gpt-6-sol · Thinking: Low, Medium, High",
  );
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
      path: "/api/admin/enterprise/settings/modelAllowlist",
      body: {
        value: {
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

test("unticking the default says it stays offered, and what Only allowed models would do", async () => {
  const view = await draw(ProvidersPage);
  fireEvent.click(await view.findByRole("button", { name: /Allowed models/ }));
  const dialog = await view.findByRole("dialog");
  await waitFor(() => expect(dialog.textContent).toContain("GPT-5.6 Terra"));
  expect(dialog.textContent).not.toContain("stays offered");
  fireEvent.click(view.getByRole("checkbox", { name: "Allow GPT-5.6 Terra" }));
  await waitFor(() => expect(dialog.textContent).toContain("stays offered"));
  expect(dialog.textContent).toContain(
    "openai/gpt-5.6-terra is the default and stays offered. With Only allowed models on, a built-in Bot on it is refused unless you allow it.",
  );
});

test("Permissions holds the organization's switches", async () => {
  const view = await draw(PermissionsPage);
  fireEvent.click(await view.findByRole("switch", { name: "Use Bots" }));
  await waitFor(() =>
    expect(writes).toContainEqual({
      path: "/api/admin/enterprise/capabilities",
      body: {
        scopeKind: "organization",
        scopeId: "",
        capability: "useBots",
        allowed: false,
      },
    }),
  );
  expect(view.getByRole("button", { name: /Role and group overrides/ }));
});

test("the allowed-models row names the first few models", () => {
  expect(allowedSummary([])).toBe("None listed");
  expect(allowedSummary(["openai/a", "openai/b"])).toBe("openai/a, openai/b");
  expect(
    allowedSummary(["openai/a", "openai/b", "openai/c", "openai/d", "x/e"]),
  ).toBe("openai/a, openai/b, openai/c and 2 more");
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
      path: "/api/admin/enterprise/settings/modelAllowlist",
      body: { value: { enabled: true, models: ["openai/gpt-5.6-terra"] } },
    }),
  );
});
