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
import {
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
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
/** The edition getDeployment says: the team edition unless a test says otherwise. */
let edition: "team" | "personal" = "team";
/** Whether getDeployment says people sign in through the hosted sign-in (OpenBot Cloud). */
let hostedSignIn = false;
/** Every getManagementEnrollment the app made, in any organization. */
let reads = 0;
/** getDeployment, answered in whichever organization the app asks it in. */
const DEPLOYMENT = /^\/api\/v2\/organizations\/[^/]+\/deployment$/;
/** getManagementEnrollment in any organization: only `default` is ever answered with a state. */
const ANY_MANAGEMENT = /^\/api\/v2\/organizations\/[^/]+\/management$/;

function serving() {
  writes.length = 0;
  writeAnswer = null;
  edition = "team";
  hostedSignIn = false;
  reads = 0;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    if (DEPLOYMENT.test(path) && method === "GET")
      return json(200, { edition, hostedSignIn });
    if (ANY_MANAGEMENT.test(path) && method === "GET") {
      reads += 1;
      if (path !== MANAGEMENT)
        return json(
          404,
          problem(
            404,
            "MANAGEMENT_UNAVAILABLE",
            "Managed updates aren't available for this OpenBot.",
          ).body,
        );
      return json(answer.status, answer.body);
    }
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
  // What CopilotKit gets, and who sets the window, said before Connect: the approval page's words.
  const before = view.getByText(/CopilotKit sees this install's version/);
  expect(before.textContent).toContain(
    "CopilotKit sees this install's version and health, and upgrades it during a maintenance window. The window is agreed with CopilotKit; the default is Tuesdays, 14:00 to 18:00 UTC.",
  );
  // The approval page signs people in with the CopilotKit account the licence is under.
  expect(before.textContent).toContain(
    "the CopilotKit account your licence is under",
  );
  expect(
    view.queryByText(/OpenBot account|OpenBot by CopilotKit account/),
  ).toBeNull();
  fireEvent.click(view.getByRole("button", { name: "Connect" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]).toMatchObject({ method: "POST", path: ENROLLMENT });
  expect(writes[0]?.idempotencyKey).toMatch(/^[0-9a-f]{32}$/);
  // The answer is read again, and the page moves on to the code.
  expect(await view.findByText("WDJB-MJHT")).toBeTruthy();
});

test("waiting for approval shows the code, the install's name, its page and when it expires, and Cancel stops it at once", async () => {
  answer = {
    status: 200,
    body: { ...WAITING_FOR_APPROVAL, installName: "Acme production" },
  };
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
      "Open the approval page and sign in to CopilotKit as an admin of the organization your licence belongs to. Check the code matches, then approve it. This page moves on by itself.",
    ),
  ).toBeTruthy();
  // Next to the code, so the admin can match it to what the approval page shows.
  expect(view.getByText("Acme production")).toBeTruthy();

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
  await view.findByText("Step 2 of 2: install the management agent");
  // One flag per line with backslash line endings, which still pastes as one command.
  const shown = document.querySelector("[data-management-helm]")?.textContent;
  expect(shown).toBe(
    [
      "helm install openbot-agent oci://ghcr.io/copilotkit/charts/openbot-agent \\",
      "  --namespace openbot-system \\",
      "  --create-namespace \\",
      "  --set enrollment.serverUrl=http://openbot-server-internal.openbot.svc:9464",
    ].join("\n"),
  );
  expect(
    view.getByText(/This page updates itself when the agent reports in\./),
  ).toBeTruthy();
  expect(view.getByRole("button", { name: "Copy the command" })).toBeTruthy();
  expect(view.getByText("6f1d2c3b-8a4e-4b5f-9c7d-0e1f2a3b4c5d")).toBeTruthy();
  expect(view.getByRole("button", { name: "Cancel" })).toBeTruthy();
});

test("on a build that isn't a release, the server's note sits beside the command, and only then", async () => {
  const NOTE =
    "This OpenBot isn't a published release, so the command installs the newest published agent.";
  answer = {
    status: 200,
    body: {
      state: "waiting-for-agent",
      installId: "6f1d2c3b-8a4e-4b5f-9c7d-0e1f2a3b4c5d",
      helmCommand: HELM,
      helmCommandNote: NOTE,
    },
  };
  const view = await draw(ManagementPage);
  expect(await view.findByText(NOTE)).toBeTruthy();
  // Beside the command, in the same card: not an error at the top of the page.
  expect(view.queryByRole("alert")).toBeNull();
  view.unmount();
  answer = {
    status: 200,
    body: {
      state: "waiting-for-agent",
      installId: "6f1d2c3b-8a4e-4b5f-9c7d-0e1f2a3b4c5d",
      helmCommand: HELM,
    },
  };
  const release = await draw(ManagementPage);
  await release.findByText("Step 2 of 2: install the management agent");
  expect(release.queryByText(NOTE)).toBeNull();
});

test("connected shows the last heartbeat, the agent's version and how to disconnect", async () => {
  answer = {
    status: 200,
    body: {
      state: "connected",
      installId: "6f1d2c3b-8a4e-4b5f-9c7d-0e1f2a3b4c5d",
      lastHeartbeatAt: new Date(Date.now() - 2 * 60_000).toISOString(),
      agentVersion: "0.4.0",
      window: { weekday: 4, startUtc: "22:30", hours: 6 },
    },
  };
  const view = await draw(ManagementPage);
  expect(await view.findByText("Connected")).toBeTruthy();
  // The install's own window, as the service reports it.
  expect(
    view.getByText("Thursdays, 22:30 UTC to 04:30 UTC the next day"),
  ).toBeTruthy();
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
  // A confirmation first: coming back needs a new code and a new approval.
  expect(await view.findByText("Disconnect managed updates?")).toBeTruthy();
  expect(writes).toHaveLength(0);
  const confirm = view
    .getAllByRole("button", { name: "Disconnect" })
    .find((button) => button.closest("[role=dialog]"));
  fireEvent.click(confirm as HTMLElement);
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
  fireEvent.click(
    (await view.findAllByRole("button", { name: "Disconnect" })).find(
      (button) => button.closest("[role=dialog]"),
    ) as HTMLElement,
  );
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

test("Disconnect waits for its confirmation, and Keep managed updates changes nothing", async () => {
  answer = { status: 200, body: CONNECTED_SILENT };
  const view = await draw(ManagementPage);
  await view.findByText("Not reporting");
  fireEvent.click(view.getByRole("button", { name: "Disconnect" }));
  fireEvent.click(
    await view.findByRole("button", { name: "Keep managed updates" }),
  );
  await waitFor(() =>
    expect(view.queryByText("Disconnect managed updates?")).toBeNull(),
  );
  expect(writes).toHaveLength(0);
});

test("once the code is approved, Cancel asks first, and only Stop connecting stops it", async () => {
  answer = {
    status: 200,
    body: {
      state: "waiting-for-agent",
      installId: "6f1d2c3b-8a4e-4b5f-9c7d-0e1f2a3b4c5d",
      helmCommand: HELM,
    },
  };
  const view = await draw(ManagementPage);
  await view.findByText("Step 2 of 2: install the management agent");
  fireEvent.click(view.getByRole("button", { name: "Cancel" }));
  expect(await view.findByText("Stop connecting?")).toBeTruthy();
  expect(writes).toHaveLength(0);
  answer = { status: 200, body: { state: "not-connected" } };
  fireEvent.click(view.getByRole("button", { name: "Stop connecting" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]).toMatchObject({ method: "DELETE", path: ENROLLMENT });
});

test("a licence without managed updates offers no Connect, and links to CopilotKit's contact page", async () => {
  answer = {
    status: 200,
    body: {
      state: "not-connected",
      lastError: "Your licence doesn't include managed updates.",
      lastErrorCode: "not-entitled",
    },
  };
  const view = await draw(ManagementPage);
  expect(await view.findByText("Not in your licence")).toBeTruthy();
  expect(view.queryByRole("button", { name: "Connect" })).toBeNull();
  expect(
    view.getByText(/Your licence doesn't include managed updates\./),
  ).toBeTruthy();
  expect(
    view
      .getByRole("link", { name: "copilotkit.ai/contact-us" })
      .getAttribute("href"),
  ).toBe("https://www.copilotkit.ai/contact-us");
  // Said once, in the state itself, not again as an error above it.
  expect(view.queryByRole("alert")).toBeNull();
});

test("a Connect refused for the licence shows the not-in-your-licence state at once", async () => {
  writeAnswer = problem(
    409,
    "MANAGEMENT_REFUSED",
    "Your licence doesn't include managed updates.",
  );
  const view = await draw(ManagementPage);
  fireEvent.click(await view.findByRole("button", { name: "Connect" }));
  // The server keeps the refusal, and the page reads it again after the refused write.
  answer = {
    status: 200,
    body: {
      state: "not-connected",
      lastError: "Your licence doesn't include managed updates.",
      lastErrorCode: "not-entitled",
    },
  };
  expect(await view.findByText("Not in your licence")).toBeTruthy();
  expect(view.queryByRole("button", { name: "Connect" })).toBeNull();
});

/*
 * On by default: where OpenBot's chart installs the management agent, OpenBot connects by itself by
 * its licence, and an admin's Disconnect turns managed updates off until Connect.
 */
const CHART_CONNECTED = {
  state: "connected",
  agentInstalledByChart: true,
  installId: "6f1d2c3b-8a4e-4b5f-9c7d-0e1f2a3b4c5d",
  lastHeartbeatAt: new Date(Date.now() - 20_000).toISOString(),
  agentVersion: "0.5.0",
  window: { weekday: 2, startUtc: "14:00", hours: 4 },
  upgrades: "not-set-up",
};

test("connecting by itself says so, with what CopilotKit gets, and Stop asks first", async () => {
  answer = {
    status: 200,
    body: { state: "connecting", agentInstalledByChart: true },
  };
  const view = await draw(ManagementPage);
  expect(await view.findByText("Connecting")).toBeTruthy();
  const connecting = view.getByText(
    /CopilotKit sees this install's version/,
  ).textContent;
  // The consent and window sentences, then one short line on what is happening.
  expect(connecting).toBe(
    "CopilotKit sees this install's version and health, and upgrades it during a maintenance window. The window is agreed with CopilotKit; the default is Tuesdays, 14:00 to 18:00 UTC. OpenBot is connecting with its licence. This page updates itself.",
  );
  // Nothing to approve and nothing to install.
  expect(view.queryByText(/approve/i)).toBeNull();
  expect(view.queryByText(/helm install/)).toBeNull();
  fireEvent.click(view.getByRole("button", { name: "Stop" }));
  expect(await view.findByText("Stop connecting?")).toBeTruthy();
  expect(view.getByText(/doesn't try again by itself/).textContent).toContain(
    "Connect turns managed updates back on.",
  );
  expect(writes).toHaveLength(0);
  answer = {
    status: 200,
    body: { state: "opted-out", agentInstalledByChart: true },
  };
  fireEvent.click(view.getByRole("button", { name: "Stop connecting" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]).toMatchObject({ method: "DELETE", path: ENROLLMENT });
  expect(await view.findByText("Turned off")).toBeTruthy();
});

test("connected with the chart's agent says whether upgrades are set up, and links to how", async () => {
  answer = { status: 200, body: CHART_CONNECTED };
  const view = await draw(ManagementPage);
  expect(await view.findByText("Upgrades")).toBeTruthy();
  expect(view.getByText("Not set up")).toBeTruthy();
  const how = view.getByRole("link", { name: "How to set up upgrades" });
  expect(how.getAttribute("href")).toBe(
    "https://github.com/CopilotKit/OpenBot/blob/main/docs/managed-upgrades.md",
  );
  // On the Upgrades row itself, not a second line under the card.
  expect(how.closest("[data-slot=item]")?.textContent).toContain("Upgrades");
  expect(
    view.getByText(/Needs a one-time setup in the cluster\./),
  ).toBeTruthy();
  // The section is named for what it does; only its button says Disconnect.
  expect(view.getByText("Turn off managed updates")).toBeTruthy();
  expect(
    view.getByText(
      "Managed updates stop, and you upgrade OpenBot yourself. Connect turns them back on.",
    ),
  ).toBeTruthy();
  // The chart's agent: no uninstall command to run before Disconnect.
  expect(view.queryByText(/helm uninstall/)).toBeNull();

  queryClient.clear();
  cleanup();
  answer = { status: 200, body: { ...CHART_CONNECTED, upgrades: "on" } };
  const on = await draw(ManagementPage);
  expect(await on.findByText("On")).toBeTruthy();
  expect(on.queryByRole("link", { name: "How to set up upgrades" })).toBeNull();
});

test("Disconnect of the chart's agent asks first, says Connect turns them back on, and lands on Turned off", async () => {
  answer = { status: 200, body: CHART_CONNECTED };
  const view = await draw(ManagementPage);
  await view.findByText("Upgrades");
  fireEvent.click(view.getByRole("button", { name: "Disconnect" }));
  expect(await view.findByText("Disconnect managed updates?")).toBeTruthy();
  expect(
    view.getByText(/OpenBot stops getting managed updates/).textContent,
  ).toBe(
    "OpenBot stops getting managed updates, and you upgrade it yourself. Connect turns them back on.",
  );
  answer = {
    status: 200,
    body: { state: "opted-out", agentInstalledByChart: true },
  };
  fireEvent.click(
    within(view.getByRole("dialog")).getByRole("button", {
      name: "Disconnect",
    }),
  );
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]).toMatchObject({ method: "DELETE", path: ENROLLMENT });
  expect(await view.findByText("Turned off")).toBeTruthy();
});

/*
 * Management turned off with Helm (`management.enabled=false`) after the chart's agent connected:
 * that upgrade removed the agent along with OpenBot's own release, so there is no `openbot-agent`
 * release, and `helm uninstall openbot-agent` would fail. The server says so with
 * agentRemovedWithChart, and Disconnect finishes on its own.
 */
const REMOVED_WITH_CHART = {
  ...CHART_CONNECTED,
  agentInstalledByChart: false,
  agentRemovedWithChart: true,
};

test("after management is turned off with Helm, the chart's agent is gone with OpenBot's release: no uninstall command, Disconnect finishes", async () => {
  answer = { status: 200, body: REMOVED_WITH_CHART };
  const view = await draw(ManagementPage);
  expect(await view.findByText("Upgrades")).toBeTruthy();
  // Never a command that fails: there is no openbot-agent release to uninstall.
  expect(view.queryByText(/helm uninstall/)).toBeNull();
  expect(
    view.queryByRole("button", { name: "Copy the uninstall command" }),
  ).toBeNull();
  expect(
    view.getByText(/Turning management off with Helm removed/).textContent,
  ).toBe(
    "Turning management off with Helm removed the management agent along with OpenBot's own release, so there is nothing to uninstall. Choose Disconnect to finish. OpenBot keeps running as it is, and you upgrade it yourself from then on.",
  );
  fireEvent.click(view.getByRole("button", { name: "Disconnect" }));
  expect(await view.findByText("Disconnect managed updates?")).toBeTruthy();
  // The chart no longer installs the agent, so coming back is the approval flow.
  expect(
    view.getByText(/OpenBot stops getting managed updates/).textContent,
  ).toBe(
    "OpenBot stops getting managed updates, and you upgrade it yourself. Connecting again needs a new code and a new approval.",
  );
  answer = { status: 200, body: { state: "not-connected" } };
  fireEvent.click(
    within(view.getByRole("dialog")).getByRole("button", {
      name: "Disconnect",
    }),
  );
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]).toMatchObject({ method: "DELETE", path: ENROLLMENT });
  expect(await view.findByText("Not connected")).toBeTruthy();
});

test("turned off offers Connect, which turns managed updates back on", async () => {
  answer = {
    status: 200,
    body: { state: "opted-out", agentInstalledByChart: true },
  };
  const view = await draw(ManagementPage);
  expect(await view.findByText("Turned off")).toBeTruthy();
  expect(view.getByText(/Managed updates are off/).textContent).toBe(
    "Managed updates are off, so OpenBot doesn't connect by itself. Connect to turn them back on. CopilotKit sees this install's version and health, and upgrades it during a maintenance window. The window is agreed with CopilotKit; the default is Tuesdays, 14:00 to 18:00 UTC.",
  );
  fireEvent.click(view.getByRole("button", { name: "Connect" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]).toMatchObject({ method: "POST", path: ENROLLMENT });
});

test("not connected with the chart's agent says OpenBot connects by itself, with no code to approve", async () => {
  answer = {
    status: 200,
    body: {
      state: "not-connected",
      agentInstalledByChart: true,
      lastError:
        "Couldn't reach the managed updates service at enroll.bot.copilotkit.ai. Check that OpenBot can reach it, then try again.",
      lastErrorCode: "unreachable",
    },
  };
  const view = await draw(ManagementPage);
  expect(await view.findByText("Not connected")).toBeTruthy();
  expect(view.getByRole("alert").textContent).toContain(
    "Couldn't reach the managed updates service",
  );
  // Under the server's error, an instruction, never a claim that it connects by itself.
  expect(view.getByText(/tries again every hour/).textContent).toContain(
    "OpenBot tries again every hour. Connect to try now.",
  );
  expect(view.queryByText(/connects by itself/)).toBeNull();
  expect(view.queryByText(/approve a code/)).toBeNull();
  expect(view.getByRole("button", { name: "Connect" })).toBeTruthy();
});

test("on the personal edition Admin never asks for managed updates, so no request of it fails", async () => {
  edition = "personal";
  answer = problem(
    404,
    "MANAGEMENT_UNAVAILABLE",
    "Managed updates aren't available for this OpenBot.",
  );
  const rail = await draw(Rail);
  expect(await rail.findByText("Identity providers")).toBeTruthy();
  await waitFor(() =>
    expect(
      queryClient.getQueryState(["deployment", "capabilities"])?.status,
    ).toBe("success"),
  );
  expect(rail.queryByText("Managed updates")).toBeNull();
  cleanup();
  const page = await draw(ManagementPage);
  expect(await page.findByText("Not available here")).toBeTruthy();
  expect(reads).toBe(0);
});

/*
 * Found on OpenBot Cloud (1.2.0-rc.5): every Admin page asked for managed updates and was answered
 * 404, in every organization. Management is never an organization admin's there, and it is answered
 * only in `default` anywhere, so Admin asks nowhere else.
 */
test("on OpenBot Cloud Admin never asks for managed updates, so no Admin page gets a 404", async () => {
  hostedSignIn = true;
  setCurrentOrganization("01a2117e-8fe4-7a8c-b7ae-62d649749aaa");
  const rail = await draw(Rail);
  expect(await rail.findByText("AI providers")).toBeTruthy();
  await waitFor(() =>
    expect(
      queryClient.getQueryState(["deployment", "capabilities"])?.status,
    ).toBe("success"),
  );
  await settleReactWork();
  expect(rail.queryByText("Managed updates")).toBeNull();
  cleanup();
  const page = await draw(ManagementPage);
  expect(await page.findByText("Not available here")).toBeTruthy();
  expect(reads).toBe(0);
});

test("on a hosted OpenBot Admin doesn't ask even in default", async () => {
  hostedSignIn = true;
  const rail = await draw(Rail);
  expect(await rail.findByText("AI providers")).toBeTruthy();
  await waitFor(() =>
    expect(
      queryClient.getQueryState(["deployment", "capabilities"])?.status,
    ).toBe("success"),
  );
  await settleReactWork();
  expect(reads).toBe(0);
});

test("a team OpenBot's other organizations don't ask either: only default is answered", async () => {
  setCurrentOrganization("acme");
  const rail = await draw(Rail);
  expect(await rail.findByText("Identity providers")).toBeTruthy();
  await waitFor(() =>
    expect(
      queryClient.getQueryState(["deployment", "capabilities"])?.status,
    ).toBe("success"),
  );
  await settleReactWork();
  expect(rail.queryByText("Managed updates")).toBeNull();
  expect(reads).toBe(0);
});

test("on the team edition Admin asks, and lists it where it applies", async () => {
  edition = "team";
  const view = await draw(Rail);
  expect(await view.findByText("Managed updates")).toBeTruthy();
  expect(reads).toBeGreaterThan(0);
});

/*
 * A server from before connecting by licence answers only the four states of the approval flow, and
 * neither agentInstalledByChart nor upgrades. The screen is the approval flow, whole.
 */
test("a server that doesn't say agentInstalledByChart or upgrades gets the approval flow, with no empty rows", async () => {
  answer = { status: 200, body: { state: "not-connected" } };
  const view = await draw(ManagementPage);
  expect(await view.findByText("Not connected")).toBeTruthy();
  expect(view.getByText(/approve a code/)).toBeTruthy();
  expect(view.queryByText(/every hour|by itself|with its licence/)).toBeNull();
  expect(view.queryByRole("alert")).toBeNull();

  queryClient.clear();
  cleanup();
  answer = {
    status: 200,
    body: {
      state: "connected",
      installId: "6f1d2c3b-8a4e-4b5f-9c7d-0e1f2a3b4c5d",
      lastHeartbeatAt: new Date(Date.now() - 60_000).toISOString(),
      agentVersion: "0.4.0",
      window: { weekday: 2, startUtc: "14:00", hours: 4 },
    },
  };
  const connected = await draw(ManagementPage);
  expect(await connected.findByText("Connected")).toBeTruthy();
  const rows = [...document.querySelectorAll("[data-slot=item]")];
  expect(
    rows.map((row) => row.querySelector("[data-slot=item-title]")?.textContent),
  ).toEqual([
    "Status",
    "Last heartbeat",
    "Agent version",
    "Maintenance window",
    "Install ID",
  ]);
  for (const row of rows)
    expect(row.querySelector("[data-slot=item-actions]")?.textContent).not.toBe(
      "",
    );
  expect(connected.queryByText("Upgrades")).toBeNull();
  expect(
    connected.queryByRole("link", { name: "How to set up upgrades" }),
  ).toBeNull();
  // The agent installed by hand: uninstall with Helm first, under the section from before.
  expect(
    connected.getByText(
      "helm uninstall openbot-agent --namespace openbot-system",
    ),
  ).toBeTruthy();
  expect(connected.getByText("Disconnect", { selector: "h2,h3" })).toBeTruthy();
  expect(connected.queryByText("Turn off managed updates")).toBeNull();
  expect(connected.queryByRole("alert")).toBeNull();
});
