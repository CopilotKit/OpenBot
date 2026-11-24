import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { PlanBanner } from "@/components/layout/plan-banner";
import { AddCardButton } from "@/components/plan/add-card-button";
import type { OrganizationPlan } from "@/lib/api/generated/model";
import { getGetOrganizationPlanMockHandler } from "@/lib/api/generated/organizations/organizations.msw";
import { setCurrentOrganization } from "@/lib/organizations/current";
import { queryClient as appQueryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/**
 * Where an organization's plan reaches the person, read through the client generated from
 * api/openapi.yaml at the API's own address and answered by the spec's own mock handler.
 *
 * The bar over every page says nothing while runs are left on the free trial, and while Bots can't
 * run it says so in words its reader can act on: an owner or an admin gets the link to add a card,
 * a member is told to ask an admin. An OpenBot that needs no plan, and one from before plans that
 * has no such address, draw nothing.
 */

const ADD_CARD = "/api/auth/hosted/checkout?organizationId=default";
const requests: string[] = [];
const server = setupServer(
  http.all("*", () => new HttpResponse(null, { status: 404 })),
);
server.events.on("request:start", ({ request }) => {
  const url = new URL(request.url);
  requests.push(`${request.method} ${url.pathname}`);
});

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://openbot.invalid/" });
  server.listen({ onUnhandledRequest: "error" });
  setCurrentOrganization("default");
});
afterEach(() => {
  cleanup();
  // The button beside a refusal reads the app's own client, as everything in a conversation does.
  appQueryClient.clear();
  server.resetHandlers();
  requests.length = 0;
});
afterAll(async () => {
  server.close();
  await settleReactWork();
  setCurrentOrganization(undefined);
  GlobalRegistrator.unregister();
});

function answer(plan: OrganizationPlan) {
  server.use(getGetOrganizationPlanMockHandler(plan));
}

function draw() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <PlanBanner />
      <AddCardButton />
    </QueryClientProvider>,
  );
}

const none = (addCardUrl: string | null): OrganizationPlan => ({
  required: true,
  status: "none",
  freeRunsUsedPercent: 100,
  freeRunsAllowance: 500,
  trialEndsAt: null,
  renewsAt: null,
  addCardUrl,
});

test("an admin of an organization with no card is told Bots can't run, and given the way to add one", async () => {
  answer(none(ADD_CARD));
  const view = draw();

  const bar = await view.findByRole("complementary", { name: "Plan" });
  expect(bar.textContent).toContain(
    "You've used your free trial. Add a card to keep your Bots running.",
  );
  const links = view.getAllByRole("link", { name: "Add a card" });
  // The bar's link, and the one beside a refused run: both leave for the same page.
  expect(links.map((link) => link.getAttribute("href"))).toEqual([
    ADD_CARD,
    ADD_CARD,
  ]);
  expect(requests).toContain("GET /api/v2/organizations/default/plan");
});

test("a member of an organization with no card is told to ask an admin, with nothing to click", async () => {
  answer(none(null));
  const view = draw();

  const bar = await view.findByRole("complementary", { name: "Plan" });
  expect(bar.textContent).toBe(
    "You've used your free trial. Ask an admin to add a card to keep your Bots running.",
  );
  expect(view.queryAllByRole("link")).toHaveLength(0);
});

test("a failed payment asks an admin to update the card", async () => {
  answer({ ...none(ADD_CARD), status: "past_due" });
  const view = draw();

  const bar = await view.findByRole("complementary", { name: "Plan" });
  expect(bar.textContent).toContain("Your last payment didn't go through");
  expect(view.getAllByRole("link", { name: "Update card" })).toHaveLength(2);
});

test("while runs are left on the free trial nothing shows over the page, and Bots run", async () => {
  answer({
    required: true,
    status: "free",
    freeRunsUsedPercent: 42,
    trialEndsAt: null,
    renewsAt: null,
    addCardUrl: null,
  });
  const view = draw();
  await waitFor(() =>
    expect(requests).toContain("GET /api/v2/organizations/default/plan"),
  );
  await settleReactWork();
  expect(view.container.textContent).toBe("");
});

test("an OpenBot that needs no plan, or one from before plans, draws nothing", async () => {
  answer({
    required: false,
    status: "not_required",
    trialEndsAt: null,
    renewsAt: null,
    addCardUrl: null,
  });
  const first = draw();
  await waitFor(() =>
    expect(requests).toContain("GET /api/v2/organizations/default/plan"),
  );
  await settleReactWork();
  expect(first.container.textContent).toBe("");
  cleanup();

  // No such address at all: the catch-all answers 404.
  server.resetHandlers();
  requests.length = 0;
  const older = draw();
  await waitFor(() =>
    expect(requests).toContain("GET /api/v2/organizations/default/plan"),
  );
  await settleReactWork();
  expect(older.container.textContent).toBe("");
});
