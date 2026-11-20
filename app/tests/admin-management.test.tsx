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
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { setCurrentOrganization } from "@/lib/organizations/current";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/*
 * Admin, Managed updates, against the API's own answers for getManagementEnrollment,
 * startManagementEnrollment and cancelManagementEnrollment, faked at the fetch boundary. The Admin
 * rail lists the page only where the server says management applies; the page draws each of the
 * four states the server can be in, and Connect and Cancel are the API's writes.
 */
const { ManagementPage } = await import("@/routes/_authed/admin/management");
const { useAdminSections } = await import("@/components/admin/admin-sections");
const { managementQueryOptions } = await import("@/lib/management/queries");

const NativeResponse = globalThis.Response;

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const MANAGEMENT = "/api/v2/organizations/default/management";
const ENROLLMENT = `${MANAGEMENT}/enrollment`;

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

/** What getManagementEnrollment answers; a status of 404 is management not applying. */
let answer: { status: number; body: unknown };
const writes: {
  method: string;
  path: string;
  idempotencyKey: string | null;
}[] = [];

function problem(status: number, code: string, detail: string) {
  return {
    status,
    body: {
      type: `https://open.bot/errors/${code.toLowerCase()}`,
      title: detail,
      status,
      detail,
      code,
      category: status === 404 ? "not_found" : "conflict",
      retryable: false,
      requestId: "req_test",
      traceId: "trace_test",
    },
  };
}

function json(status: number, body: unknown) {
  return new NativeResponse(JSON.stringify(body), {
    status,
    headers: {
      "content-type":
        status >= 400 ? "application/problem+json" : "application/json",
    },
  });
}

/** What a write answers next, when a test wants it refused. */
let writeAnswer: { status: number; body: unknown } | null;

function serving() {
  writes.length = 0;
  writeAnswer = null;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    if (path === MANAGEMENT && method === "GET")
      return json(answer.status, answer.body);
    if (path === ENROLLMENT && (method === "POST" || method === "DELETE")) {
      writes.push({
        method,
        path,
        idempotencyKey: new Headers(init?.headers).get("Idempotency-Key"),
      });
      if (writeAnswer) return json(writeAnswer.status, writeAnswer.body);
      if (method === "DELETE") return new NativeResponse(null, { status: 204 });
      answer = { status: 200, body: WAITING_FOR_APPROVAL };
      return json(200, WAITING_FOR_APPROVAL);
    }
    return json(404, { error: "not served" });
  }) as unknown as typeof fetch;
}

const WAITING_FOR_APPROVAL = {
  state: "waiting-for-approval",
  userCode: "WDJB-MJHT",
  verificationUri: "https://enroll.bot.copilotkit.ai/connect",
  verificationUriComplete:
    "https://enroll.bot.copilotkit.ai/connect?code=WDJB-MJHT",
  expiresAt: new Date(Date.now() + 14 * 60_000).toISOString(),
};

const HELM =
  "helm install openbot-agent oci://ghcr.io/copilotkit/charts/openbot-agent --namespace openbot-system --create-namespace --set enrollment.serverUrl=http://openbot-server-internal.openbot.svc:9464";

beforeEach(() => {
  queryClient.clear();
  setCurrentOrganization("default");
  answer = { status: 200, body: { state: "not-connected" } };
  serving();
});

async function draw(page: () => React.ReactNode) {
  const router = createRouter({
    routeTree: createRootRoute({ component: page }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

function Rail() {
  const sections = useAdminSections();
  return (
    <ul>
      {sections.flatMap((section) =>
        section.items.map((item) => <li key={item.title}>{item.title}</li>),
      )}
    </ul>
  );
}

test("the Admin rail lists Managed updates where the server says it applies", async () => {
  const view = await draw(Rail);
  expect(await view.findByText("Managed updates")).toBeTruthy();
});

test("the Admin rail leaves it out where the server answers MANAGEMENT_UNAVAILABLE", async () => {
  answer = problem(
    404,
    "MANAGEMENT_UNAVAILABLE",
    "Managed updates aren't available for this OpenBot.",
  );
  const view = await draw(Rail);
  expect(await view.findByText("Identity providers")).toBeTruthy();
  await waitFor(() =>
    expect(queryClient.getQueryState(["management", "status"])?.status).toBe(
      "success",
    ),
  );
  expect(view.queryByText("Managed updates")).toBeNull();
});

test("where it doesn't apply, the page says so and offers nothing to press", async () => {
  answer = problem(
    404,
    "MANAGEMENT_UNAVAILABLE",
    "Managed updates aren't available for this OpenBot.",
  );
  const view = await draw(ManagementPage);
  expect(await view.findByText("Not available here")).toBeTruthy();
  expect(view.queryByRole("button", { name: "Connect" })).toBeNull();
});

test("not connected offers Connect, which starts connecting with an Idempotency-Key", async () => {
  const view = await draw(ManagementPage);
  expect(await view.findByText("Not connected")).toBeTruthy();
  // The approval page signs people in with the account the licence is under, not OpenBot's own
  // sign-in, so the screen never sends an admin to their OpenBot account.
  expect(
    view.getByText(
      "An admin of the organization your OpenBot licence is for approves a code on the approval page. Then you install the management agent with one Helm command.",
    ),
  ).toBeTruthy();
  expect(view.queryByText(/OpenBot account/)).toBeNull();
  fireEvent.click(view.getByRole("button", { name: "Connect" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]).toMatchObject({ method: "POST", path: ENROLLMENT });
  expect(writes[0]?.idempotencyKey).toMatch(/^[0-9a-f]{32}$/);
  // The answer is read again, and the page moves on to the code.
  expect(await view.findByText("WDJB-MJHT")).toBeTruthy();
});

test("waiting for approval shows the code, its page and when it expires, and Cancel stops it", async () => {
  answer = { status: 200, body: WAITING_FOR_APPROVAL };
  const view = await draw(ManagementPage);
  expect(await view.findByText("WDJB-MJHT")).toBeTruthy();
  const page = view.getByRole("button", { name: "Open the approval page" });
  expect(page.getAttribute("href")).toBe(
    "https://enroll.bot.copilotkit.ai/connect?code=WDJB-MJHT",
  );
  expect(page.getAttribute("target")).toBe("_blank");
  expect(view.getByText(/The code expires in 1[34] minutes\./)).toBeTruthy();
  expect(view.getByRole("button", { name: "Copy the code" })).toBeTruthy();
  expect(
    view.getByText(
      "Sign in on the approval page with your OpenBot by CopilotKit account, the one your licence is under, as an admin of that organization. Then confirm this code. OpenBot carries on by itself once it's approved.",
    ),
  ).toBeTruthy();
  expect(view.queryByText(/OpenBot account/)).toBeNull();

  answer = { status: 200, body: { state: "not-connected" } };
  fireEvent.click(view.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]).toMatchObject({ method: "DELETE", path: ENROLLMENT });
  expect(writes[0]?.idempotencyKey).toMatch(/^[0-9a-f]{32}$/);
  expect(await view.findByText("Not connected")).toBeTruthy();
});

test("waiting for the agent shows the Helm command to copy, and nothing secret", async () => {
  answer = {
    status: 200,
    body: {
      state: "waiting-for-agent",
      installId: "6f1d2c3b-8a4e-4b5f-9c7d-0e1f2a3b4c5d",
      helmCommand: HELM,
    },
  };
  const view = await draw(ManagementPage);
  expect(await view.findByText(HELM)).toBeTruthy();
  expect(
    view.getByText("Step 2 of 2: install the management agent"),
  ).toBeTruthy();
  expect(view.getByRole("button", { name: "Copy the command" })).toBeTruthy();
  expect(view.getByText("6f1d2c3b-8a4e-4b5f-9c7d-0e1f2a3b4c5d")).toBeTruthy();
  expect(view.getByRole("button", { name: "Cancel" })).toBeTruthy();
});

test("connected shows the last heartbeat, the agent's version and how to disconnect", async () => {
  answer = {
    status: 200,
    body: {
      state: "connected",
      installId: "6f1d2c3b-8a4e-4b5f-9c7d-0e1f2a3b4c5d",
      lastHeartbeatAt: new Date(Date.now() - 2 * 60_000).toISOString(),
      agentVersion: "0.4.0",
    },
  };
  const view = await draw(ManagementPage);
  expect(await view.findByText("Connected")).toBeTruthy();
  expect(view.getByText("2 minutes ago")).toBeTruthy();
  expect(view.getByText("0.4.0")).toBeTruthy();
  expect(
    view.getByText("helm uninstall openbot-agent --namespace openbot-system"),
  ).toBeTruthy();
  expect(view.queryByRole("button", { name: "Connect" })).toBeNull();
  expect(view.getByRole("button", { name: "Disconnect" })).toBeTruthy();
});

const NOT_REPORTING =
  "The management agent hasn't reported in for more than five minutes. If you uninstalled it, choose Disconnect to finish. If not, check the openbot-agent pod in the openbot-system namespace.";

const CONNECTED_SILENT = {
  state: "connected",
  installId: "6f1d2c3b-8a4e-4b5f-9c7d-0e1f2a3b4c5d",
  lastHeartbeatAt: new Date(Date.now() - 12 * 60_000).toISOString(),
  agentVersion: "0.4.0",
  lastError: NOT_REPORTING,
};

test("connected but silent says Not reporting, with the server's sentence", async () => {
  answer = { status: 200, body: CONNECTED_SILENT };
  const view = await draw(ManagementPage);
  expect(await view.findByText("Not reporting")).toBeTruthy();
  expect(view.queryByText("Connected")).toBeNull();
  expect(view.getByText("12 minutes ago")).toBeTruthy();
  expect(view.getByRole("alert").textContent).toBe(NOT_REPORTING);
});

test("Disconnect after uninstalling forgets the connection and goes back to not connected", async () => {
  answer = { status: 200, body: CONNECTED_SILENT };
  const view = await draw(ManagementPage);
  await view.findByText("Not reporting");
  answer = { status: 200, body: { state: "not-connected" } };
  fireEvent.click(view.getByRole("button", { name: "Disconnect" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]).toMatchObject({ method: "DELETE", path: ENROLLMENT });
  expect(writes[0]?.idempotencyKey).toMatch(/^[0-9a-f]{32}$/);
  expect(await view.findByText("Not connected")).toBeTruthy();
});

test("a Disconnect refused while the agent still reports in says why", async () => {
  answer = {
    status: 200,
    body: { ...CONNECTED_SILENT, lastError: undefined },
  };
  const view = await draw(ManagementPage);
  await view.findByText("Connected");
  const refusal =
    "The management agent is still reporting in. Uninstall it with Helm first, then choose Disconnect.";
  writeAnswer = problem(409, "MANAGEMENT_AGENT_REPORTING", refusal);
  fireEvent.click(view.getByRole("button", { name: "Disconnect" }));
  expect((await view.findByRole("alert")).textContent).toBe(refusal);
  expect(view.getByText("Connected")).toBeTruthy();
});

test("the screen keeps asking while connected, so a silent agent shows without a reload", () => {
  const interval = managementQueryOptions().refetchInterval as (query: {
    state: { data: unknown };
  }) => number | false;
  const asked = (data: unknown) => interval({ state: { data } });
  expect(
    asked({ applies: true, status: { state: "waiting-for-approval" } }),
  ).toBe(5_000);
  expect(asked({ applies: true, status: { state: "waiting-for-agent" } })).toBe(
    5_000,
  );
  expect(asked({ applies: true, status: { state: "connected" } })).toBe(30_000);
  expect(asked({ applies: true, status: { state: "not-connected" } })).toBe(
    false,
  );
  expect(asked({ applies: false })).toBe(false);
});

test("the last attempt's error is said in the server's own sentence", async () => {
  answer = {
    status: 200,
    body: {
      state: "not-connected",
      lastError:
        "The code expired before anybody approved it. Connect again to get a new one.",
    },
  };
  const view = await draw(ManagementPage);
  expect((await view.findByRole("alert")).textContent).toBe(
    "The code expired before anybody approved it. Connect again to get a new one.",
  );
});

test("a refused Connect says why, in the server's own sentence", async () => {
  const view = await draw(ManagementPage);
  await view.findByText("Not connected");
  writeAnswer = problem(
    409,
    "MANAGEMENT_REFUSED",
    "The licence in COPILOTKIT_LICENSE_TOKEN wasn't accepted. Check it, or contact OpenBot by CopilotKit.",
  );
  fireEvent.click(view.getByRole("button", { name: "Connect" }));
  expect((await view.findByRole("alert")).textContent).toBe(
    "The licence in COPILOTKIT_LICENSE_TOKEN wasn't accepted. Check it, or contact OpenBot by CopilotKit.",
  );
});

test("a state this app doesn't know reads as not connected", async () => {
  answer = { status: 200, body: { state: "paused-by-copilotkit" } };
  const view = await draw(ManagementPage);
  expect(await view.findByText("Not connected")).toBeTruthy();
});
