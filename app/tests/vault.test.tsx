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
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render } from "@testing-library/react";
import { VaultPage } from "@/components/vault/vault-page";
import { credentialKeys } from "@/lib/credentials/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import { passwordKeys } from "@/lib/passwords/queries";
import { Route as CredentialsRoute } from "@/routes/_authed/settings/credentials";
import { Route as NewCredentialRoute } from "@/routes/_authed/settings/credentials_.new";
import { Route as PasswordsRoute } from "@/routes/_authed/settings/passwords";
import { settleReactWork } from "./settle-react-work";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

function draw(edition: "team" | "personal") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    selfHostBanner: false,
    localEvaluation: edition === "personal",
    edition,
  });
  client.setQueryData(passwordKeys.logins(), {
    passwordManager: true,
    logins: [
      {
        id: "l1",
        origin: "https://example.com",
        username: "me@example.com",
        createdAt: "2026-11-01T00:00:00Z",
        updatedAt: "2026-11-01T00:00:00Z",
        lastUsedAt: null,
      },
    ],
  });
  client.setQueryData(credentialKeys.list(), [
    {
      id: "c1",
      kind: "model",
      provider: "openai",
      keyId: "default",
      revokedAt: null,
    },
  ]);
  const root = createRootRoute();
  const vault = createRoute({
    path: "/settings/vault",
    getParentRoute: () => root,
    component: VaultPage,
  });
  const router = createRouter({
    routeTree: root.addChildren([vault]),
    history: createMemoryHistory({ initialEntries: ["/settings/vault"] }),
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

describe("the Vault", () => {
  test("holds saved logins and keys in the personal edition", async () => {
    const view = draw("personal");
    expect(await view.findByRole("heading", { name: "Vault" })).toBeTruthy();
    expect(view.getByRole("heading", { name: "Logins" })).toBeTruthy();
    expect(view.getByText("https://example.com")).toBeTruthy();
    expect(view.getByRole("heading", { name: "Keys" })).toBeTruthy();
    expect(view.getByText("openai")).toBeTruthy();
    expect(view.getByText("Add key").closest("a")?.getAttribute("href")).toBe(
      "/settings/vault/new",
    );
  });

  test("holds only saved logins in the team edition, where keys are an admin's", async () => {
    const view = draw("team");
    expect(await view.findByRole("heading", { name: "Vault" })).toBeTruthy();
    expect(view.getByText("https://example.com")).toBeTruthy();
    expect(view.queryByRole("heading", { name: "Keys" })).toBeNull();
    expect(view.queryByText("openai")).toBeNull();
  });

  test("in the team edition says it keeps logins alone, under no second heading", async () => {
    const view = draw("team");
    await view.findByText("https://example.com");
    expect(
      view.getByText("Your saved logins are kept here. Bots never see them."),
    ).toBeTruthy();
    expect(view.queryByText(/logins and keys/)).toBeNull();
    // One section: the page title already names it.
    expect(view.queryByRole("heading", { name: "Logins" })).toBeNull();
    expect(view.getAllByRole("heading").map((h) => h.textContent)).toEqual([
      "Vault",
    ]);
  });

  test("in the personal edition says it keeps logins and keys", async () => {
    const view = draw("personal");
    expect(
      await view.findByText(
        "Your saved logins and keys are kept here. Bots never see them.",
      ),
    ).toBeTruthy();
  });

  test("a key's row has an icon tile, as a login's row above it does", async () => {
    const view = draw("personal");
    for (const name of ["https://example.com", "openai"]) {
      const row = (await view.findByText(name)).closest(
        "[data-slot=item]",
      ) as HTMLElement;
      const media = row.querySelector(
        "[data-slot=item-media][data-variant=icon]",
      );
      expect({ name, icon: media?.querySelector(".tabler-icon-key") }).toEqual({
        name,
        icon: expect.anything(),
      });
    }
  });
});

function redirectOf(route: { options: { beforeLoad?: unknown } }) {
  try {
    (route.options.beforeLoad as () => void)();
  } catch (thrown) {
    return (thrown as { options?: { to?: string } }).options?.to;
  }
  return undefined;
}

test.each([
  ["/settings/passwords", PasswordsRoute, "/settings/vault"],
  ["/settings/credentials", CredentialsRoute, "/settings/vault"],
])("%s opens the Vault", (_from, route, to) => {
  expect(redirectOf(route as never)).toBe(to);
});

/** Where `/settings/credentials/new` goes, for an edition (`null`: the edition could not be read). */
async function newKeyGoesTo(edition: "team" | "personal" | null) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  if (edition)
    client.setQueryData(deploymentKeys.capabilities(), {
      generativeUi: true,
      selfHostBanner: false,
      localEvaluation: edition === "personal",
      edition,
    });
  try {
    await (
      NewCredentialRoute.options.beforeLoad as unknown as (input: {
        context: { queryClient: QueryClient };
      }) => Promise<void>
    )({ context: { queryClient: client } });
  } catch (thrown) {
    return (thrown as { options?: { to?: string } }).options?.to;
  }
  return undefined;
}

test("the old address for adding a key opens the Vault's form, or the Vault where there is no form", async () => {
  const originalFetch = global.fetch;
  global.fetch = (async () =>
    new Response(null, { status: 500 })) as unknown as typeof fetch;
  try {
    expect(await newKeyGoesTo("personal")).toBe("/settings/vault/new");
    expect(await newKeyGoesTo("team")).toBe("/settings/vault");
    // Not known: the Vault, which every edition has.
    expect(await newKeyGoesTo(null)).toBe("/settings/vault");
  } finally {
    global.fetch = originalFetch;
  }
});
