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
import { ME_PATH, meResponse } from "./accounts-api";
import { APPS_SETTING_PATH, appsSettingResponse } from "./admin-settings-api";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const originalFetch = global.fetch;
let role: "user" | "admin" = "user";
let apps: unknown[] = [];
let pending: unknown[] = [];
const posted: unknown[] = [];
/**
 * The organization's apps switch. Locked down unless a test opens it: the notice and its Request
 * approval are what locked down still has.
 */
let lockedDown = true;
/** Whether the shared apps were read at all. */
let sharedReads = 0;
beforeEach(() => {
  posted.length = 0;
  lockedDown = true;
  sharedReads = 0;
  global.fetch = Object.assign(
    async (path: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(path);
      if (url === APPS_SETTING_PATH) return appsSettingResponse(lockedDown);
      if (url === ME_PATH)
        return meResponse({
          user: { id: "me", email: "me@example.test", role },
        });
      if (
        /^\/api\/v2\/organizations\/default\/bots\/[^/]+\/shared-use$/.test(url)
      ) {
        sharedReads += 1;
        return Response.json({ apps, pending });
      }
      if (
        url === "/api/v2/organizations/default/shared-use-requests" &&
        init?.method === "POST"
      ) {
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

  test("apps open: says nothing and asks for nothing, to an owner or an admin", async () => {
    lockedDown = false;
    apps = [gh(false)];
    pending = [];
    for (const who of ["user", "admin"] as const) {
      role = who;
      const view = draw();
      // Once the switch has answered, and well after: nothing to say, nothing read for it.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(view.container.textContent).toBe("");
      expect(view.queryByRole("button")).toBeNull();
      cleanup();
    }
    expect(sharedReads).toBe(0);
    expect(posted).toEqual([]);
  });

  test("apps locked down: an owner is told calls will be refused and can ask, once", async () => {
    role = "user";
    apps = [gh(false)];
    pending = [];
    const view = draw();
    const ask = await view.findByRole("button", {
      name: "Request approval for Team GitHub",
    });
    expect(
      view.getByText(
        /can't use the shared Team GitHub account until an admin approves/,
      ),
    ).toBeTruthy();
    await userEvent.click(ask);
    expect(posted).toEqual([
      { botId: "bot1", serverId: "gh", reason: "publish" },
    ]);
  });

  test("apps locked down: a request already waiting is shown instead of a button", async () => {
    role = "user";
    apps = [gh(false)];
    pending = [{ serverId: "gh", id: "r0" }];
    const view = draw();
    expect(
      await view.findByText(
        "Waiting for an admin to approve the shared Team GitHub account.",
      ),
    ).toBeTruthy();
    expect(view.queryByRole("button")).toBeNull();
  });

  test("apps locked down: an admin is told saving approves it", async () => {
    role = "admin";
    apps = [gh(true)];
    pending = [];
    const view = draw();
    expect(
      await view.findByText(
        /Saving also lets everyone who can use this Bot use the shared Team GitHub account/,
      ),
    ).toBeTruthy();
  });
});
