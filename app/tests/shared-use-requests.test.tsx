// app/tests/shared-use-requests.test.tsx
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
import { SharedUseRequests } from "../src/components/approvals/shared-use-requests";
import { ME_PATH, meResponse } from "./accounts-api";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const originalFetch = global.fetch;
let role: "user" | "admin" = "admin";
let alreadyDecided = false;
/** The requests waiting for an admin, at the API's address. */
const SHARED_USE_REQUESTS = "/api/v2/organizations/default/shared-use-requests";
const posted: string[] = [];
const request = {
  id: "r1",
  botId: "bot1",
  botName: "Helpdesk",
  ownerUserId: "dana",
  serverId: "gh",
  title: "Team GitHub",
  proposed: { audience: "team", outsideInput: true, members: [] },
  current: { audience: "owner", outsideInput: false, members: [] },
  reason: "refused_call",
  requestedBy: "sam",
  status: "pending",
  createdAt: "2026-10-07T03:00:00.000Z",
};
beforeEach(() => {
  posted.length = 0;
  alreadyDecided = false;
  global.fetch = Object.assign(
    async (path: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(path);
      if (url === ME_PATH)
        return meResponse({
          user: { id: "me", email: "me@example.test", role },
        });
      if (url === `${SHARED_USE_REQUESTS}?limit=100`)
        return Response.json({
          sharedUseRequests: [request],
          nextCursor: null,
        });
      if (init?.method === "POST") {
        posted.push(url);
        if (alreadyDecided)
          return Response.json(
            {
              type: "https://open.bot/errors/shared-use-request-decided",
              title: "That request has already been decided.",
              status: 409,
              detail: "That request has already been decided.",
              code: "SHARED_USE_REQUEST_DECIDED",
              category: "conflict",
              retryable: false,
              requestId: "req_test",
              traceId: "trace_test",
            },
            {
              status: 409,
              headers: { "content-type": "application/problem+json" },
            },
          );
        return Response.json({ ...request, status: "approved" });
      }
      return new Response(null, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  global.fetch = originalFetch;
});

const draw = () =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <SharedUseRequests />
    </QueryClientProvider>,
  );

describe("Shared account requests", () => {
  test("shows what is asked against what is approved now, and why", async () => {
    role = "admin";
    const view = draw();
    expect(
      await view.findByText("Helpdesk wants the shared Team GitHub account"),
    ).toBeTruthy();
    expect(view.getByText("Now: Only its owner")).toBeTruthy();
    expect(view.getByText("Asked: Everyone, and outside input")).toBeTruthy();
    expect(
      view.getByText(
        "An action was blocked. This Bot reaches more people than approved.",
      ),
    ).toBeTruthy();
  });

  test("approving posts once", async () => {
    role = "admin";
    const view = draw();
    await userEvent.click(await view.findByRole("button", { name: "Approve" }));
    expect(posted).toEqual([`${SHARED_USE_REQUESTS}/r1/approve`]);
  });

  test("a request another admin already answered says so", async () => {
    role = "admin";
    alreadyDecided = true;
    const view = draw();
    await userEvent.click(await view.findByRole("button", { name: "Decline" }));
    expect(
      await view.findByText("That request has already been decided."),
    ).toBeTruthy();
  });

  test("is not drawn for someone who is not an administrator", async () => {
    role = "user";
    const view = draw();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(view.queryByText(/Shared account requests/)).toBeNull();
  });
});
