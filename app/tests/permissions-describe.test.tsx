import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { previewHeadline } from "@/components/admin/controls/describe-capabilities";
import { decisionText, subjectText } from "@/components/audit/audit-cells";
import { Route as DescribeRoute } from "@/routes/_authed/admin/permissions_.describe";
import {
  CAPABILITIES,
  CAPABILITY_LABELS,
  DEFAULT_CAPABILITIES,
} from "../../server/src/admin/capabilities";
import {
  applyCapabilityChanges,
  type CapabilityChange,
  changesWarning,
  checkCapabilityChanges,
  type PreviewMember,
  previewCapabilityChanges,
} from "../../server/src/admin/capability-changes";
import type { AuditEvent, AuditReader } from "../../server/src/audit";
import recorded from "../../server/tests/fixtures/who-can-recorded.json";

/**
 * Who can do what, described in English, on Admin → Permissions → Describe it in words: the model's
 * switch changes land as rows beside their independent reading and whether they check; who they
 * change is shown person by person with what each would lose and their recent use of it; and only
 * Save writes them, with the sentence.
 *
 * The server's answers come from the server's own code: the translation is the recording the route
 * test uses, checked and warned about by the server's own check, and the preview is
 * `previewCapabilityChanges` over the people that test seeds. The route test
 * (server/tests/who-can.integration.test.ts) holds both against a real database.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 50));
  await GlobalRegistrator.unregister();
});

const person = (
  key: string,
  name: string,
  groups: string[],
  role: "admin" | "user" = "user",
): PreviewMember => ({
  id: `user-${key}`,
  email: `${key}@acme.test`,
  name,
  groups,
  role,
});
const PEOPLE = [
  person("ada", "Ada Admin", [], "admin"),
  person("cam", "Cam Contractor", ["Contractors"]),
  person("cy", "Cy Contractor", ["Contractors", "Engineering"]),
  person("eve", "Eve Engineer", ["Engineering"]),
  person("lee", "Lee Field", ["Field Sales (EMEA)"]),
  person("nora", "Nora Nogroup", []),
  person("sam", "Sam Sales", ["Sales"]),
];
const GROUPS = ["Contractors", "Engineering", "Field Sales (EMEA)", "Sales"];

/** Cam's own computer, used once this month: what the trail's reader answers for them. */
const CAM_ROW: AuditEvent = {
  id: "audit-cam-1",
  actorUserId: "user-cam",
  initiatorKind: "person",
  initiatorId: null,
  eventType: "computer.action_allowed",
  targetType: "host_access",
  targetId: "grant-projects",
  payload: {
    action: "host/run_command",
    bot: "bot-research",
    actor: "user-cam",
    folder: "Projects",
    command: "ls -la",
  },
  createdAt: "2026-11-08T15:04:05.000Z",
};
const reader: AuditReader = {
  list: async (query) => ({
    events:
      query.actorUserId === "user-cam" && query.targetType === "host_access"
        ? [CAM_ROW]
        : [],
  }),
};

const TEXT = recorded.trap.text;
const reading = JSON.parse(recorded.trap.reader);

/** What the translate route answers for the recording: the writer's changes, checked, and the reading. */
const SETTING = { on: true, off: false, inherit: null } as const;
const WRITTEN: CapabilityChange[] = (
  JSON.parse(recorded.trap.writer[0] as string) as {
    changes: (Omit<CapabilityChange, "allowed"> & {
      setting: keyof typeof SETTING;
    })[];
  }
).changes.map(({ setting, ...change }) => ({
  ...change,
  allowed: SETTING[setting],
}));
const TRANSLATION = {
  changes: WRITTEN,
  summary: reading.summary,
  explanation: reading.explanation,
  check: checkCapabilityChanges(WRITTEN, GROUPS),
  warning: changesWarning(applyCapabilityChanges([], WRITTEN), WRITTEN, GROUPS),
};

const sent: { path: string; body: Record<string, unknown> }[] = [];
const originalFetch = global.fetch;

beforeEach(() => {
  sent.length = 0;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (init?.method === "POST") sent.push({ path, body });
    if (path.endsWith("/api/admin/enterprise/capabilities/translate"))
      return Response.json(TRANSLATION);
    if (path.endsWith("/api/admin/enterprise/capabilities/preview"))
      return Response.json(
        await previewCapabilityChanges({
          changes: body.changes as CapabilityChange[],
          rows: [],
          members: PEOPLE,
          groups: GROUPS,
          reader,
          now: new Date("2026-11-09T12:00:00.000Z"),
        }),
      );
    if (path.endsWith("/api/admin/enterprise/capabilities/batch"))
      return Response.json({ saved: body.changes });
    if (path.endsWith("/api/admin/enterprise"))
      return Response.json({
        capabilities: CAPABILITIES.map((capability) => ({
          capability,
          ...CAPABILITY_LABELS[capability],
          default: DEFAULT_CAPABILITIES[capability],
          organization: null,
          roles: {},
          groups: {},
        })),
        groups: GROUPS,
      });
    if (path.includes("/api/agents"))
      return Response.json({
        agents: [{ id: "bot-research", name: "Research" }],
      });
    return Response.json({ error: "unexpected" }, { status: 404 });
  }) as typeof fetch;
});
afterEach(() => {
  global.fetch = originalFetch;
});

function open() {
  const root = createRootRoute({ component: Outlet });
  const permissions = createRoute({
    path: "/admin/permissions",
    getParentRoute: () => root,
    component: () => null,
  });
  const describe = (
    DescribeRoute as unknown as { update: (options: unknown) => never }
  ).update({
    id: "/admin/permissions_/describe",
    path: "/admin/permissions/describe",
    getParentRoute: () => root,
  });
  const router = createRouter({
    routeTree: root.addChildren([permissions, describe]),
    history: createMemoryHistory({
      initialEntries: ["/admin/permissions/describe"],
    }),
  });
  const view = render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return { view, router };
}

async function describeChange(view: ReturnType<typeof render>) {
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.type(await view.findByLabelText("Describe the change"), TEXT);
  await user.click(view.getByRole("button", { name: "Write changes" }));
}

test("a description lands as switches with their reading, shows who loses and keeps access and what they used, and Save writes them with the sentence", async () => {
  const { view, router } = open();
  await describeChange(view);

  expect(await view.findByText(reading.explanation)).toBeTruthy();
  expect(
    view.getByText(
      "Checks. Every change names a permission, role or group this OpenBot has.",
    ),
  ).toBeTruthy();
  // The switches, in the Permissions page's own words: off for everybody, granted to the other groups.
  expect(view.getAllByText("Local computer access")).toHaveLength(4);
  expect(view.getByText("Everybody")).toBeTruthy();
  expect(view.getByText("Off")).toBeTruthy();
  expect(view.getByText("Group: Field Sales (EMEA)")).toBeTruthy();
  expect(view.getAllByText("Grant")).toHaveLength(3);

  // Who it changes, as the server worked it out for every person.
  expect(
    await view.findByText(
      "3 people lose access and 4 people keep it through a different switch.",
    ),
  ).toBeTruthy();
  expect(view.getByText("Cam Contractor")).toBeTruthy();
  expect(view.getByText("Member in Contractors")).toBeTruthy();
  expect(view.getByText("Admin, in no group")).toBeTruthy();
  expect(view.getAllByText("Loses access")).toHaveLength(3);
  expect(view.getAllByText("Keeps access")).toHaveLength(4);
  expect(
    view.getAllByText("Now on by default. After this, off for everybody.", {
      exact: false,
    }),
  ).toHaveLength(3);
  // The contractor who is also an engineer keeps it, through Engineering, as the engineer does.
  expect(
    view.getAllByText(
      "Now on by default. After this, on through Engineering.",
      { exact: false },
    ),
  ).toHaveLength(2);
  // What Cam used, counted and listed in Audit's own words, and nobody else used any.
  expect(
    view.getByText("1 in the last 30 days: actions on their own computer."),
  ).toBeTruthy();
  expect(view.getAllByText("Not used in the last 30 days.")).toHaveLength(2);
  expect(view.getByText("Would be blocked")).toBeTruthy();
  expect(view.getByText("Cam Contractor, Local computer access")).toBeTruthy();
  expect(sent.filter((call) => call.path.endsWith("/batch"))).toHaveLength(0);

  const save = view.getByRole("button", { name: "Save changes" });
  await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(save);
  await waitFor(() =>
    expect(sent.filter((call) => call.path.endsWith("/batch"))).toHaveLength(1),
  );
  expect(sent.find((call) => call.path.endsWith("/batch"))?.body).toEqual({
    changes: [
      {
        scopeKind: "organization",
        scopeId: "",
        capability: "localComputer",
        allowed: false,
      },
      {
        scopeKind: "group",
        scopeId: "Engineering",
        capability: "localComputer",
        allowed: true,
      },
      {
        scopeKind: "group",
        scopeId: "Field Sales (EMEA)",
        capability: "localComputer",
        allowed: true,
      },
      {
        scopeKind: "group",
        scopeId: "Sales",
        capability: "localComputer",
        allowed: true,
      },
    ],
    authoring: { source: "english", text: TEXT },
  });
  await waitFor(() =>
    expect(router.state.location.pathname).toBe("/admin/permissions"),
  );
});

test("removing a change is called out and shows who the rest would change", async () => {
  const { view } = open();
  await describeChange(view);
  await view.findByText(
    "3 people lose access and 4 people keep it through a different switch.",
  );
  expect(view.queryByText(/You've removed a change/)).toBeNull();

  // Without Sales's grant, Sam loses it too.
  fireEvent.click(view.getByRole("button", { name: "Remove change 4" }));

  expect(
    view.getByText(
      "You've removed a change since they were written. The check and the reading above are for the written changes, not your edit.",
    ),
  ).toBeTruthy();
  expect(
    await view.findByText(
      "4 people lose access and 3 people keep it through a different switch.",
    ),
  ).toBeTruthy();
  expect(
    sent.filter((call) => call.path.endsWith("/preview")).at(-1)?.body.changes,
  ).toHaveLength(3);
});

test("each saved switch reads on Audit as which permission, for whom, and what it was set to", () => {
  const row = (payload: Record<string, unknown>) => ({
    id: "1",
    actorUserId: "admin-1",
    initiatorKind: "person",
    initiatorId: "admin-1",
    eventType: "capability.changed",
    targetType: "capability",
    targetId: "localComputer",
    createdAt: "2026-11-09T17:26:34.000Z",
    payload: { capability: "localComputer", ...payload },
  });
  // One sentence saved three of these, and each read "Change a permission · Allowed".
  const everybody = row({
    title: "Local computer access",
    scopeKind: "organization",
    scopeId: "",
    allowed: false,
  });
  const sales = row({
    title: "Local computer access",
    scopeKind: "group",
    scopeId: "Sales",
    allowed: true,
  });
  expect(subjectText(everybody)).toBe("Local computer access · Everybody");
  expect(decisionText(everybody)).toBe("Turned off");
  expect(subjectText(sales)).toBe("Local computer access · Group: Sales");
  expect(decisionText(sales)).toBe("Granted");
  // A row from before the title was kept names the permission by its key.
  expect(
    subjectText(row({ scopeKind: "role", scopeId: "admin", allowed: true })),
  ).toBe("localComputer · Admins");
});

test("the headline names only what changes", () => {
  expect(
    previewHeadline({
      people: 7,
      losing: 1,
      gaining: 0,
      keeping: 0,
      unchanged: 6,
    }),
  ).toBe("1 person loses access.");
  expect(
    previewHeadline({
      people: 7,
      losing: 0,
      gaining: 2,
      keeping: 1,
      unchanged: 4,
    }),
  ).toBe(
    "2 people gain access and 1 person keeps it through a different switch.",
  );
  expect(
    previewHeadline({
      people: 7,
      losing: 0,
      gaining: 0,
      keeping: 0,
      unchanged: 7,
    }),
  ).toBe("Nobody's access changes.");
});
