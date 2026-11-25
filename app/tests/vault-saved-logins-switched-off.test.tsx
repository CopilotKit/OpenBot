import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SavedLogins } from "@/components/vault/saved-logins";
import { queryClient } from "@/query-client";
import { DEPLOYMENT_PATH, deploymentResponse } from "./admin-settings-api";
import { settleReactWork } from "./settle-react-work";

/**
 * The Vault with saved logins turned off by an admin, where the person already saved some.
 *
 * The server still lists them, and deleting one is not behind the switch. So the Vault keeps the
 * list and each row's delete button, with a notice that saving is off, that these won't be offered
 * or used, and that the person can delete them. It used to put "Saved logins are off" in place of
 * the list, which left the person no way to delete what they had saved.
 *
 * Drawn for real: the Vault's own query and mutation, through the generated client, against a
 * server stand-in at the API's addresses that keeps every request it was sent.
 */

const SAVED_LOGINS_PATH =
  "/api/v2/organizations/default/people/me/saved-logins";

const LOGINS = [
  {
    id: "l1",
    origin: "https://portal.example",
    username: "ada@example.com",
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z",
    lastUsedAt: null,
  },
  {
    id: "l2",
    origin: "https://billing.example",
    username: "ada",
    createdAt: "2026-11-02T00:00:00Z",
    updatedAt: "2026-11-02T00:00:00Z",
    lastUsedAt: "2026-11-10T00:00:00Z",
  },
];

let originalFetch: typeof fetch;

beforeAll(() => {
  GlobalRegistrator.register();
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

function serve(passwordManager: boolean) {
  let logins = [...LOGINS];
  const asked: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), "http://openbot.test").pathname;
    const method = init?.method ?? "GET";
    asked.push(`${method} ${path}`);
    if (path === DEPLOYMENT_PATH)
      return deploymentResponse({ botComputers: true });
    if (path === SAVED_LOGINS_PATH && method === "GET")
      return Response.json({
        savedLogins: logins,
        passwordManager,
        nextCursor: null,
      });
    if (path.startsWith(`${SAVED_LOGINS_PATH}/`) && method === "DELETE") {
      const id = path.slice(SAVED_LOGINS_PATH.length + 1);
      logins = logins.filter((login) => login.id !== id);
      return new Response(null, { status: 204 });
    }
    return Response.json({ detail: "Not here." }, { status: 404 });
  }) as typeof fetch;
  return { asked };
}

function draw() {
  return render(
    <QueryClientProvider client={queryClient}>
      <SavedLogins />
    </QueryClientProvider>,
  );
}

test("with saving turned off, the Vault still lists the logins, each with its delete button, under a notice", async () => {
  serve(false);
  const view = draw();

  expect(await view.findByText("https://portal.example")).toBeTruthy();
  expect(view.getByText("https://billing.example")).toBeTruthy();
  expect(
    view.getByRole("button", {
      name: "Delete login for https://portal.example",
    }),
  ).toBeTruthy();
  expect(
    view.getByRole("button", {
      name: "Delete login for https://billing.example",
    }),
  ).toBeTruthy();
  // The notice: saving is off, these won't be offered or used, and they can be deleted.
  expect(view.getByText("Saved logins are off")).toBeTruthy();
  expect(view.container.textContent).toContain("won't be offered or used");
  expect(view.container.textContent).toContain("You can delete them");
});

test("with saving turned off, a delete button deletes that login", async () => {
  const server = serve(false);
  const user = userEvent.setup({ document });
  const view = draw();

  await user.click(
    await view.findByRole("button", {
      name: "Delete login for https://portal.example",
    }),
  );
  expect(server.asked).toContain(`DELETE ${SAVED_LOGINS_PATH}/l1`);
  await waitFor(() =>
    expect(view.queryByText("https://portal.example")).toBeNull(),
  );
  expect(view.getByText("https://billing.example")).toBeTruthy();
});

test("with saving on, the list has no notice", async () => {
  serve(true);
  const view = draw();

  expect(await view.findByText("https://portal.example")).toBeTruthy();
  expect(view.queryByText("Saved logins are off")).toBeNull();
});
