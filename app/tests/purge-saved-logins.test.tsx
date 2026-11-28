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
import { cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { CapabilitiesSection } from "@/components/admin/controls/capabilities-section";
import { getListCapabilitiesMockHandler } from "@/lib/api/generated/capabilities/capabilities.msw";
import type { Capability } from "@/lib/api/generated/model";
import { getListNetworkPoliciesMockHandler } from "@/lib/api/generated/network-policies/network-policies.msw";
import { getGetOrganizationSettingsMockHandler } from "@/lib/api/generated/organization-settings/organization-settings.msw";
import {
  getGetUnusableSavedLoginsMockHandler,
  getPurgeSavedLoginsMockHandler,
} from "@/lib/api/generated/saved-logins/saved-logins.msw";
import { deploymentKeys } from "@/lib/deployment/queries";
import { setCurrentOrganization } from "@/lib/organizations/current";
import { queryClient } from "@/query-client";
import { settingsBody } from "./admin-settings-api";
import { settleReactWork } from "./settle-react-work";

/**
 * Admin, Permissions: beside the Password manager switch, an admin can delete the saved logins
 * nobody may use any more, those of people the switch is off for and of people no longer in the
 * organization (`purgeSavedLogins`).
 *
 * The button first reads how many it would delete (`getUnusableSavedLogins`) and asks with those
 * numbers, saying it can't be undone. Only then is the purge called, with an `Idempotency-Key`,
 * and the two counts in its answer are shown. An OpenBot that doesn't serve either yet answers the
 * API's plain not found, which says so in place of a failure and takes the button away. The
 * personal edition shows no Permissions switches, so no button either.
 *
 * The server is the spec's own MSW handlers, as in isolated-bots-permission.test.tsx.
 */
const capabilities: Capability[] = [
  {
    id: "passwordManager",
    title: "Password manager",
    description:
      "People may save logins, and sign a Bot in with a login they saved.",
    default: true,
    organization: false,
    roles: {},
    groups: {},
    teams: {},
  },
  {
    id: "cloudBrowser",
    title: "Cloud browser",
    description: "Bots may browse the web on a computer of their own.",
    default: true,
    organization: null,
    roles: {},
    groups: {},
    teams: {},
  },
];

const PURGE_PATH = "/api/v2/organizations/default/saved-logins/purge";
const UNUSABLE_PATH = "/api/v2/organizations/default/saved-logins/unusable";
const purges: { idempotencyKey: string | null }[] = [];
const reads: string[] = [];

const server = setupServer(
  getGetOrganizationSettingsMockHandler(() => settingsBody({}) as never),
  getListCapabilitiesMockHandler(() => ({ capabilities, nextCursor: null })),
  getListNetworkPoliciesMockHandler(() => ({
    networkPolicies: [],
    nextCursor: null,
  })),
  http.all("*", () => new HttpResponse(null, { status: 404 })),
);

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://openbot.invalid/" });
  server.listen({ onUnhandledRequest: "error" });
});
beforeEach(() => {
  setCurrentOrganization("default");
  queryClient.clear();
  purges.length = 0;
  reads.length = 0;
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  server.resetHandlers();
});
afterAll(async () => {
  server.close();
  await settleReactWork();
  GlobalRegistrator.unregister();
});

/** A problem the API answers, as problem details. */
function problem(status: number, code: string, detail: string) {
  return HttpResponse.json(
    { type: "about:blank", title: detail, status, detail, code },
    { status, headers: { "content-type": "application/problem+json" } },
  );
}

const NOT_FOUND = () => problem(404, "NOT_FOUND", "Not found.");

type Answer = "answers" | "notServed" | "refused";

/**
 * The server. The read answers the two counts (`counts`), and the purge deletes them; either can
 * instead be an OpenBot without the route (`notServed`) or a failure (`refused`).
 */
function serve({
  read = "answers",
  purge = "answers",
  counts = { switchedOff: 12, removed: 3 },
}: {
  read?: Answer;
  purge?: Answer;
  counts?: { switchedOff: number; removed: number };
} = {}) {
  server.use(
    read === "answers"
      ? getGetUnusableSavedLoginsMockHandler(() => {
          reads.push(UNUSABLE_PATH);
          return counts;
        })
      : http.get(`*${UNUSABLE_PATH}`, () => {
          reads.push(UNUSABLE_PATH);
          return read === "notServed"
            ? NOT_FOUND()
            : problem(500, "INTERNAL", "Couldn't count them. Try again.");
        }),
    purge === "answers"
      ? getPurgeSavedLoginsMockHandler(({ request }) => {
          purges.push({
            idempotencyKey: request.headers.get("Idempotency-Key"),
          });
          return { deleted: counts };
        })
      : http.post(`*${PURGE_PATH}`, ({ request }) => {
          purges.push({
            idempotencyKey: request.headers.get("Idempotency-Key"),
          });
          return purge === "notServed"
            ? NOT_FOUND()
            : problem(
                500,
                "INTERNAL",
                "The saved logins couldn't be deleted. Try again.",
              );
        }),
  );
}

async function permissions(edition: "team" | "personal" = "team") {
  queryClient.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    selfHostBanner: false,
    localEvaluation: false,
    edition,
    isolatedBots: true,
    botComputers: true,
  });
  const router = createRouter({
    routeTree: createRootRoute({ component: CapabilitiesSection }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

const BUTTON = "Delete saved logins nobody may use";
const NOT_YET = "This OpenBot can't do this yet. Update it first.";

test("an admin is asked first with the real counts, then the purge runs and both counts are shown", async () => {
  serve();
  const user = userEvent.setup({ document });
  const view = await permissions();

  await view.findByRole("switch", { name: "Password manager" });
  // Nothing is read until the admin asks.
  expect(reads).toHaveLength(0);
  await user.click(view.getByRole("button", { name: BUTTON }));

  // Asked first, with the counts the server read, and nothing is deleted until the admin says so.
  const dialog = await view.findByRole("dialog");
  await within(dialog).findByText("Delete 15 saved logins?");
  const said = dialog.textContent ?? "";
  expect(said).toContain("12 are from people Password manager is off for");
  expect(said).toContain("3 from people no longer in the organization");
  expect(said).toContain("You can't undo this.");
  expect(reads).toHaveLength(1);
  expect(purges).toHaveLength(0);

  await user.click(within(dialog).getByRole("button", { name: "Delete them" }));

  await waitFor(() => expect(purges).toHaveLength(1));
  expect(purges[0]?.idempotencyKey).toBeTruthy();
  const result = await view.findByRole("status");
  expect(result.textContent).toContain(
    "Deleted 12 saved logins of people Password manager is off for",
  );
  expect(result.textContent).toContain(
    "3 of people no longer in the organization",
  );
});

test("the counts are read again each time the admin asks", async () => {
  serve();
  const user = userEvent.setup({ document });
  const view = await permissions();

  await user.click(await view.findByRole("button", { name: BUTTON }));
  let dialog = await view.findByRole("dialog");
  await within(dialog).findByText("Delete 15 saved logins?");
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());

  await user.click(view.getByRole("button", { name: BUTTON }));
  dialog = await view.findByRole("dialog");
  await within(dialog).findByText("Delete 15 saved logins?");
  expect(reads).toHaveLength(2);
});

test("Cancel deletes nothing", async () => {
  serve();
  const user = userEvent.setup({ document });
  const view = await permissions();

  await user.click(await view.findByRole("button", { name: BUTTON }));
  const dialog = await view.findByRole("dialog");
  await within(dialog).findByText("Delete 15 saved logins?");
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
  expect(purges).toHaveLength(0);
});

test("with nothing to delete, the dialog says so and offers no delete", async () => {
  serve({ counts: { switchedOff: 0, removed: 0 } });
  const user = userEvent.setup({ document });
  const view = await permissions();

  await user.click(await view.findByRole("button", { name: BUTTON }));
  const dialog = await view.findByRole("dialog");
  await within(dialog).findByText("No saved logins to delete");
  expect(
    within(dialog).queryByRole("button", { name: "Delete them" }),
  ).toBeNull();
  expect(purges).toHaveLength(0);
});

test("an OpenBot that doesn't serve the count says so, as no failure, takes the button away and deletes nothing", async () => {
  serve({ read: "notServed", purge: "notServed" });
  const user = userEvent.setup({ document });
  const view = await permissions();

  await user.click(await view.findByRole("button", { name: BUTTON }));
  expect(await view.findByText(NOT_YET)).toBeTruthy();
  await waitFor(() =>
    expect(view.queryByRole("button", { name: BUTTON })).toBeNull(),
  );
  await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
  expect(view.queryByRole("alert")).toBeNull();
  expect(purges).toHaveLength(0);
});

test("an OpenBot that counts but doesn't serve the purge says so too, as no failure", async () => {
  serve({ purge: "notServed" });
  const user = userEvent.setup({ document });
  const view = await permissions();

  await user.click(await view.findByRole("button", { name: BUTTON }));
  const dialog = await view.findByRole("dialog");
  await within(dialog).findByText("Delete 15 saved logins?");
  await user.click(within(dialog).getByRole("button", { name: "Delete them" }));

  await waitFor(() => expect(purges).toHaveLength(1));
  expect(await view.findByText(NOT_YET)).toBeTruthy();
  await waitFor(() =>
    expect(view.queryByRole("button", { name: BUTTON })).toBeNull(),
  );
  expect(view.queryByRole("alert")).toBeNull();
});

test("a count that fails is said as a failure, and nothing can be deleted", async () => {
  serve({ read: "refused" });
  const user = userEvent.setup({ document });
  const view = await permissions();

  await user.click(await view.findByRole("button", { name: BUTTON }));
  const dialog = await view.findByRole("dialog");
  // The app asks a failed read once more before it says so.
  const alert = await within(dialog).findByRole("alert", {}, { timeout: 4000 });
  expect(alert.textContent).toContain(
    "Couldn't count the saved logins. Try again.",
  );
  expect(
    within(dialog).queryByRole("button", { name: "Delete them" }),
  ).toBeNull();
  expect(purges).toHaveLength(0);
});

test("a purge that fails is said as a failure, and the admin can try again", async () => {
  serve({ purge: "refused" });
  const user = userEvent.setup({ document });
  const view = await permissions();

  await user.click(await view.findByRole("button", { name: BUTTON }));
  const dialog = await view.findByRole("dialog");
  await within(dialog).findByText("Delete 15 saved logins?");
  await user.click(within(dialog).getByRole("button", { name: "Delete them" }));

  const alert = await view.findByRole("alert");
  expect(alert.textContent).toContain(
    "The saved logins couldn't be deleted. Try again.",
  );
  expect(
    within(dialog).getByRole("button", { name: "Delete them" }),
  ).toBeTruthy();
});

test("the personal edition shows no Permissions switches, and no button", async () => {
  serve();
  const view = await permissions("personal");

  await settleReactWork();
  expect(view.queryByRole("button", { name: BUTTON })).toBeNull();
  expect(reads).toHaveLength(0);
  expect(purges).toHaveLength(0);
});
