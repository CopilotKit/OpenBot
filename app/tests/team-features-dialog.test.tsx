import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient } from "@tanstack/react-query";
import { isRedirect } from "@tanstack/react-router";
import { act, cleanup, render } from "@testing-library/react";
import {
  openTeamFeatures,
  TEAM_FEATURES,
  TeamFeaturesDialog,
} from "@/components/edition/team-features-dialog";
import { authKeys } from "@/lib/auth/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import { personalAdminRedirect } from "@/lib/manage-paths";
import { Route as AdminRoute } from "@/routes/_authed/admin/route";
import { settleReactWork } from "./settle-react-work";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

describe("the team features dialog", () => {
  test("lists every team feature, with Talk to us and close", async () => {
    const view = render(<TeamFeaturesDialog />);
    expect(view.queryByRole("dialog")).toBeNull();
    act(() => openTeamFeatures());
    const dialog = await view.findByRole("dialog");
    for (const feature of TEAM_FEATURES) {
      expect(dialog.textContent).toContain(feature.title);
    }
    const links = view.queryAllByRole("link");
    expect(links.map((link) => link.textContent)).toEqual(["Talk to us"]);
    expect(links[0]?.getAttribute("href")).toBe("https://open.bot/business");
    expect(links[0]?.getAttribute("target")).toBe("_blank");
    expect(
      view.queryAllByRole("button").map((button) => button.textContent),
    ).toEqual(["Close"]);
  });
});

describe("an old Admin address in the personal edition", () => {
  test.each([
    ["/admin/plugins", "/connections"],
    ["/admin/plugins/notion", "/connections/notion"],
    ["/admin/plugins/notion/tools/search", "/connections/notion/tools/search"],
    ["/admin/plugins/notion/bots/bot-1", "/connections/notion/bots/bot-1"],
    ["/admin/plugins/composio", "/connections/browse/composio"],
    ["/admin/skills", "/settings/skills"],
    ["/admin/credentials", "/settings/credentials"],
    ["/admin/credentials/new", "/settings/credentials/new"],
    ["/admin/computers", "/settings/computer"],
    ["/admin/audit", "/settings/activity"],
    ["/admin/people", "/settings"],
    ["/admin/enterprise", "/settings"],
    ["/admin", "/settings"],
    ["/admin/", "/settings"],
  ])("%s opens %s", (from, to) => {
    expect(personalAdminRedirect(from)).toBe(to);
  });

  type BeforeLoad = (input: {
    context: { queryClient: QueryClient };
    location: { pathname: string };
  }) => Promise<unknown>;
  const beforeLoad = AdminRoute.options.beforeLoad as unknown as BeforeLoad;

  function clientFor(edition: "team" | "personal") {
    const client = new QueryClient();
    client.setQueryData(authKeys.currentUser(), {
      id: "u1",
      email: "me@example.test",
      name: "Me",
      role: "admin",
    });
    client.setQueryData(deploymentKeys.capabilities(), {
      generativeUi: true,
      selfHostBanner: false,
      localEvaluation: true,
      edition,
    });
    return client;
  }

  async function outcome(edition: "team" | "personal", pathname: string) {
    try {
      await beforeLoad({
        context: { queryClient: clientFor(edition) },
        location: { pathname },
      });
      return "open";
    } catch (thrown) {
      return isRedirect(thrown) ? thrown.options.href : thrown;
    }
  }

  test("is sent to its Settings address", async () => {
    expect(
      await outcome("personal", "/admin/plugins/notion/tools/search"),
    ).toBe("/connections/notion/tools/search");
    expect(await outcome("personal", "/admin/people")).toBe("/settings");
  });

  test("still opens in the team edition", async () => {
    expect(await outcome("team", "/admin/people")).toBe("open");
  });
});
