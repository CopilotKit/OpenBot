import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
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
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { PluginPage } from "@/components/manage/plugin-page";
import { getUpdateAppMockHandler } from "@/lib/api/generated/apps/apps.msw";
import { getGetAppTeamGrantsMockHandler } from "@/lib/api/generated/bot-grants/bot-grants.msw";
import { getListTeamsMockHandler } from "@/lib/api/generated/teams/teams.msw";
import { deploymentKeys } from "@/lib/deployment/queries";
import { queryClient } from "@/query-client";
import {
  answerAppsApi,
  appPath,
  type TodayServer,
  updateAppBody,
} from "./apps-api";
import {
  APP_ACCESS_REQUESTS_PATH,
  appAccessRequestsResponse,
} from "./bot-grants-api";
import { answerBotsList } from "./bots-api";
import { connectionPage, MY_CONNECTIONS_PATH } from "./connections-api";
import { settleReactWork } from "./settle-react-work";
import { KEY, recordWrites, type SentWrite } from "./team-grants-api";

/**
 * The Every Bot switch on an app's page in Admin: an admin gives the app to every Bot in the
 * organization with one switch (updateApp with `everyBot`), and the switch reads what the server
 * then holds. The page is the real one, on the app's one query client, against a fake server that
 * keeps what updateApp sends.
 */

/** Notion, as the server holds it. */
let notion: TodayServer;
let writes: SentWrite[];

const server = setupServer(
  getListTeamsMockHandler(() => ({
    teams: [],
    canCreate: true,
    nextCursor: null,
  })),
  getGetAppTeamGrantsMockHandler(() => ({ teams: [] })),
  getUpdateAppMockHandler(async ({ request }) =>
    updateAppBody(notion, await request.json()),
  ),
  // Everything else the page reads: the app itself, its catalogue entry, Bots, accounts, requests.
  http.all("*", ({ request }) => {
    const init = { method: request.method };
    const path = new URL(request.url).pathname;
    return (
      answerAppsApi(request.url, init, {
        servers: [notion],
        catalogue: [{ key: "notion", title: "Notion", auth: "user-oauth" }],
      }) ??
      answerBotsList(request.url, init, { visible: [], hidden: [] }) ??
      (path === MY_CONNECTIONS_PATH ? connectionPage([]) : undefined) ??
      (path === APP_ACCESS_REQUESTS_PATH
        ? appAccessRequestsResponse([])
        : undefined) ??
      new HttpResponse(null, { status: 404 })
    );
  }),
);

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://openbot.invalid/" });
  server.listen({ onUnhandledRequest: "error" });
  writes = recordWrites(server);
});
beforeEach(() => {
  writes.length = 0;
  notion = {
    id: "notion",
    title: "Notion",
    summary: "Pages and databases.",
    provenance: "first-party",
    hasCredential: true,
    dynamicClient: true,
    everyBot: false,
  };
  queryClient.clear();
});
afterEach(() => {
  cleanup();
  queryClient.clear();
});
afterAll(async () => {
  server.close();
  await settleReactWork();
  GlobalRegistrator.unregister();
});

/** Notion's page in Admin, as an admin of this edition opens it. */
function open(edition: "team" | "personal" = "team") {
  queryClient.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    selfHostBanner: false,
    localEvaluation: edition === "personal",
    edition,
  });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({
      component: () => <PluginPage pluginKey="notion" />,
    }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return { view, person: userEvent.setup({ document }) };
}

test("an admin gives an app to every Bot with one switch, and the switch reads it back", async () => {
  const { view, person } = open();
  const toggle = await view.findByRole("switch", {
    name: "Give Notion to every Bot",
  });
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  expect(
    view.getByText("Only the Bots it's given to can use it."),
  ).toBeTruthy();

  await person.click(toggle);

  await waitFor(() =>
    expect(
      view
        .getByRole("switch", { name: "Give Notion to every Bot" })
        .getAttribute("aria-checked"),
    ).toBe("true"),
  );
  expect(
    view.getByText(
      "Every Bot in this organization can use it, Bots made later too.",
    ),
  ).toBeTruthy();
  await waitFor(() => expect(writes.length).toBe(1));
  expect(writes).toEqual([
    {
      method: "PATCH",
      path: appPath("notion"),
      key: KEY,
      body: { everyBot: true },
    },
  ]);

  // And takes it back with the same switch.
  await person.click(
    view.getByRole("switch", { name: "Give Notion to every Bot" }),
  );
  await waitFor(() =>
    expect(
      view
        .getByRole("switch", { name: "Give Notion to every Bot" })
        .getAttribute("aria-checked"),
    ).toBe("false"),
  );
  expect(writes.at(-1)).toEqual({
    method: "PATCH",
    path: appPath("notion"),
    key: KEY,
    body: { everyBot: false },
  });
});

test("the personal edition has no Every Bot switch", async () => {
  const { view } = open("personal");
  await view.findByRole("heading", { level: 1, name: "Notion" });
  // The page has drawn its rows: the person's own switch for the app.
  await view.findByRole("switch", { name: "Notion on for your Bots" });
  expect(
    view.queryByRole("switch", { name: "Give Notion to every Bot" }),
  ).toBeNull();
  expect(view.queryByText("Every Bot")).toBeNull();
});
