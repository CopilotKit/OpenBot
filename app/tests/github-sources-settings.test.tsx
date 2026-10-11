import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GithubSources } from "@/components/settings/github-sources";
import { settleReactWork } from "./settle-react-work";

/** Settings → Connected accounts: the repositories whose events can start a responsibility. */

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

const writes: { request: string; body: unknown }[] = [];
function serving() {
  writes.length = 0;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method !== "GET") {
      writes.push({
        request: `${method} ${String(input)}`,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      });
      return Response.json({
        binding: {
          id: "g2",
          source: "github",
          repository: "acme/web",
          createdAt: "2026-10-09T10:00:00Z",
        },
      });
    }
    return Response.json({
      bindings: [
        {
          id: "g1",
          source: "github",
          repository: "acme/app",
          createdAt: "2026-10-09T10:00:00Z",
        },
      ],
    });
  }) as unknown as typeof fetch;
}

function draw() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <GithubSources />
    </QueryClientProvider>,
  );
}

test("a connected repository shows the webhook address to paste into GitHub", async () => {
  serving();
  const view = draw();
  expect(await view.findByText("acme/app")).toBeTruthy();
  expect(view.getByText(/\/api\/events\/github\/g1$/)).toBeTruthy();
});

test("connecting a repository sends it with its secret", async () => {
  serving();
  const view = draw();
  const user = userEvent.setup({ document });
  await view.findByText("acme/app");
  await user.click(view.getByRole("button", { name: "Add a repository" }));
  await user.type(
    await view.findByRole("textbox", { name: "Repository" }),
    "acme/web",
  );
  await user.type(view.getByLabelText("Webhook secret"), "s3cret");
  fireEvent.click(view.getByRole("button", { name: "Connect events" }));
  await waitFor(() =>
    expect(writes).toContainEqual({
      request: "POST /api/responsibilities/sources/github",
      body: { repository: "acme/web", secret: "s3cret" },
    }),
  );
});
