import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NewCredentialPage } from "@/components/manage/new-credential-page";
import { deploymentKeys } from "@/lib/deployment/queries";
import {
  CREDENTIALS_PATH,
  credentialBody,
  credentialPage,
  MODEL_KEY_PATH,
  modelKeyBody,
} from "./models-api";
import { settleReactWork } from "./settle-react-work";

/**
 * The Vault's Add key form, as a person meets it after Setup says OpenBot needs an AI key.
 *
 * The Bots read one model key: the provider they run on, under the name the server keeps. The form
 * used to ask for a free-text provider and key ID, with "OpenAI" and "production" as placeholders,
 * and a person who followed them saved a key OpenBot never answered with. It now starts on the
 * provider the Bots run on, asks for no name, and leaves the name to the server.
 */

const originalFetch = globalThis.fetch;
let posted: unknown[] = [];
let keys: (string | null)[] = [];

beforeAll(() => GlobalRegistrator.register());
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  posted = [];
  keys = [];
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

/** The API's vault, as the personal edition answers it with no key saved yet. */
function serve(modelKey: { provider: string; keyId: string }) {
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://openbot.test");
      if (url.pathname === MODEL_KEY_PATH)
        return Response.json(modelKeyBody(modelKey));
      if (url.pathname !== CREDENTIALS_PATH)
        return new Response(JSON.stringify({ error: "not served" }), {
          status: 404,
        });
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        posted.push(body);
        keys.push(new Headers(init.headers).get("idempotency-key"));
        return Response.json(
          credentialBody({
            id: "credential-1",
            kind: String(body.kind),
            provider: String(body.provider),
            keyId: String(body.keyId ?? modelKey.keyId),
          }),
          { status: 201 },
        );
      }
      return Response.json(credentialPage([]));
    },
    { preconnect: originalFetch.preconnect },
  );
}

function draw() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    selfHostBanner: false,
    localEvaluation: true,
    edition: "personal",
  });
  const root = createRootRoute();
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({
        path: "/settings/vault",
        getParentRoute: () => root,
        component: () => <p>The Vault</p>,
      }),
      createRoute({
        path: "/settings/vault/new",
        getParentRoute: () => root,
        component: NewCredentialPage,
      }),
    ]),
    history: createMemoryHistory({ initialEntries: ["/settings/vault/new"] }),
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

test("a model key needs only its provider and the secret, and is saved under the name the Bots read", async () => {
  serve({ provider: "openai", keyId: "openai-api-key" });
  const view = draw();

  // It starts on the provider the Bots run on, and says they'll use the key.
  const provider = await view.findByRole("combobox", { name: "Provider" });
  expect(provider.textContent).toContain("OpenAI");
  expect(
    view.getByText("Your Bots run on OpenAI and will use this key."),
  ).toBeTruthy();
  // No name to type, so none to get wrong.
  expect(view.queryByRole("textbox", { name: "Key ID" })).toBeNull();
  expect(view.queryByRole("textbox", { name: "Provider" })).toBeNull();

  const user = userEvent.setup({ document });
  await user.type(view.getByLabelText("Secret"), "sk-added-in-the-vault");
  await user.click(view.getByRole("button", { name: "Save credential" }));

  await waitFor(() => expect(posted).toHaveLength(1));
  // The provider the person picked and the secret. The server files it under the Bots' name.
  expect(posted[0]).toEqual({
    kind: "model",
    provider: "openai",
    secret: "sk-added-in-the-vault",
    metadata: {},
  });
  // A write, made once: a retry of it would carry the same key.
  expect(keys[0]).toBeTruthy();
  expect(await view.findByText("The Vault")).toBeTruthy();
});

test("a model key starts on Anthropic when that is what the Bots run on", async () => {
  serve({ provider: "anthropic", keyId: "openai-api-key" });
  const view = draw();

  const provider = await view.findByRole("combobox", { name: "Provider" });
  expect(provider.textContent).toContain("Anthropic");
  expect(
    view.getByText("Your Bots run on Anthropic and will use this key."),
  ).toBeTruthy();
});
