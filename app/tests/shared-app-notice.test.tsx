// app/tests/shared-app-notice.test.tsx
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SharedAppNotice } from "../src/components/plugins/shared-app-notice";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const originalFetch = global.fetch;
let role: "user" | "admin" = "user";
let apps: unknown[] = [];
let pending: unknown[] = [];
const posted: unknown[] = [];
beforeEach(() => {
  posted.length = 0;
  global.fetch = Object.assign(
    async (path: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(path);
      if (url === "/api/me")
        return Response.json({
          user: { id: "me", email: "me@example.test", role },
        });
      if (url.startsWith("/api/approvals/shared-use/bot/"))
        return Response.json({ apps, pending });
      if (url === "/api/approvals/shared-use" && init?.method === "POST") {
        posted.push(JSON.parse(String(init.body)));
        return Response.json({ id: "r1", created: true });
      }
      return new Response(null, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  global.fetch = originalFetch;
});

const gh = (covered: boolean) => ({
  serverId: "gh",
  title: "Team GitHub",
  covered,
  approval: { audience: "owner", outsideInput: false, members: [] },
  needed: { audience: "team", outsideInput: false, members: [] },
});
const draw = () =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <SharedAppNotice botId="bot1" reason="publish" />
    </QueryClientProvider>,
  );

describe("SharedAppNotice", () => {
  test("says nothing for a Bot that uses no shared app", async () => {
    apps = [];
    const view = draw();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(view.container.textContent).toBe("");
  });

  test("an owner is told calls will be refused and can ask, once", async () => {
    role = "user";
    apps = [gh(false)];
    pending = [];
    const view = draw();
    const ask = await view.findByRole("button", {
      name: "Request approval for Team GitHub",
    });
    expect(
      view.getByText(
        /Team GitHub calls from this Bot are refused until an administrator approves/,
      ),
    ).toBeTruthy();
    await userEvent.click(ask);
    expect(posted).toEqual([
      { botId: "bot1", serverId: "gh", reason: "publish" },
    ]);
  });

  test("a request already waiting is shown instead of a button", async () => {
    role = "user";
    apps = [gh(false)];
    pending = [{ serverId: "gh", id: "r0" }];
    const view = draw();
    expect(
      await view.findByText("Waiting for an administrator: shared Team GitHub"),
    ).toBeTruthy();
    expect(view.queryByRole("button")).toBeNull();
  });

  test("an administrator is told saving approves it", async () => {
    role = "admin";
    apps = [gh(true)];
    pending = [];
    const view = draw();
    expect(
      await view.findByText(
        /Saving also approves the shared Team GitHub account for whoever can reach this Bot/,
      ),
    ).toBeTruthy();
  });
});
