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
import userEvent from "@testing-library/user-event";
import { NetworkSection } from "@/components/admin/controls/computer-sections";
import type { NetworkAllowlistTranslation } from "@/lib/enterprise/network-allowlist";
import type {
  NetworkCandidate,
  NetworkPolicy,
  NetworkReplayReport,
} from "@/lib/enterprise/queries";
import { queryClient } from "@/query-client";
import recorded from "../../server/tests/fixtures/network-allowlist-recorded.json";
import { settleReactWork } from "./settle-react-work";

/*
 * Admin, Computers, Network: the allowlist described in a sentence. The model's list lands in the
 * Allowlist field with its mode, beside an independent reading of what becomes reachable; the list is
 * replayed over recent page visits as it stands; and only Save saves it, with the sentence. The server
 * is faked at the fetch boundary with the shapes its routes answer with: the translation is the one
 * `POST /api/admin/enterprise/network/translate` returns for the answers recorded from the real API
 * (server/tests/network-allowlist-translate.test.ts asserts the same).
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

const written = JSON.parse(recorded.writtenFirstTime.writer[0] as string) as {
  mode: "allowlist_only";
  entries: { type: "domain"; value: string }[];
};
const reading = JSON.parse(recorded.writtenFirstTime.reader) as {
  summary: string;
  reachable: string[];
  explanation: string;
};
const TRANSLATION: NetworkAllowlistTranslation = {
  mode: written.mode,
  rules: written.entries.map(({ type, value }) => ({ type, value })),
  summary: reading.summary,
  reachable: reading.reachable,
  explanation: reading.explanation,
  check: { ok: true },
  warning: null,
};

/** What the replay answered for the visits in server/tests/network-allowlist-replay.integration.test.ts. */
const REPORT: NetworkReplayReport = {
  scanned: 6,
  covered: 5,
  wouldBlock: 3,
  wouldAllow: 1,
  undecided: 0,
  unchanged: 1,
  hosts: [
    {
      host: "www.linkedin.com",
      change: "block",
      visits: 2,
      bots: ["ops-bot"],
      lastVisit: "2026-11-09T18:00:00.000Z",
    },
    {
      host: "docs.google.com",
      change: "allow",
      visits: 1,
      bots: ["ops-bot"],
      lastVisit: "2026-11-09T18:01:00.000Z",
    },
  ],
  sites: 2,
};

/** The organization's policy in force: a domain on its own port, and one on every port. */
const IN_FORCE: NetworkPolicy = {
  scopeKind: "organization",
  scopeId: "",
  mode: "defaults_plus_allowlist",
  rules: [
    { type: "domain", value: "intranet.acme.example", ports: "8443" },
    { type: "domain", value: "hubspot.com" },
  ],
  locked: false,
  updatedBy: "admin@acme.test",
  updatedAt: "2026-11-01T00:00:00.000Z",
};

const saved: Record<string, unknown>[] = [];
const described: string[] = [];
const replayed: NetworkCandidate[] = [];

function serving() {
  saved.length = 0;
  described.length = 0;
  replayed.length = 0;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    if (path === "/api/admin/enterprise/network" && method === "PUT") {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      saved.push(body);
      const { authoring: _authoring, ...policy } = body;
      return Response.json({ saved: policy });
    }
    if (path === "/api/admin/enterprise/network/translate") {
      described.push(JSON.parse(String(init?.body)).text);
      return Response.json(TRANSLATION);
    }
    if (path === "/api/admin/enterprise/network/replay") {
      replayed.push(JSON.parse(String(init?.body)));
      return Response.json({ report: REPORT });
    }
    if (path.startsWith("/api/agents"))
      return Response.json({ agents: [{ id: "ops-bot", name: "Ops Bot" }] });
    if (path === "/api/admin/enterprise")
      return Response.json({
        capabilities: [],
        settings: {
          ssoRequired: false,
          actionRecording: false,
          inactiveComputerDays: 30,
          modelAllowlist: { enabled: false, models: [] },
          mcpAllowlist: { enabled: false, servers: [] },
          skillSharing: false,
          proactiveDailyRuns: 24,
          modelSelection: false,
        },
        groups: [],
        network: [IN_FORCE],
        defaultDestinations: [
          "github.com",
          "githubusercontent.com",
          "ghcr.io",
          "registry.npmjs.org",
          "pypi.org",
        ],
        mcpServers: [],
        builtInModel: "openai/gpt-5.6-terra",
        scim: {
          configured: false,
          connectionId: "directory",
          baseUrl: null,
          rotating: false,
        },
        otel: { configured: false },
        actionRecordRetentionDays: 90,
      });
    return Response.json({ error: "not served" }, { status: 404 });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  queryClient.clear();
  serving();
});

async function openOrganization() {
  const router = createRouter({
    routeTree: createRootRoute({ component: NetworkSection }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  fireEvent.click(await view.findByRole("button", { name: /Organization/ }));
  return { view, dialog: await view.findByRole("dialog") };
}

test("a sentence becomes the list and its mode, read back independently, replayed over page visits, and saved with the sentence", async () => {
  const { view, dialog } = await openOrganization();
  await userEvent.type(
    await view.findByLabelText("Describe the allowlist"),
    recorded.writtenFirstTime.text,
  );
  fireEvent.click(view.getByRole("button", { name: "Write list" }));

  await view.findByText(
    "Every entry is valid. Bot computers can enforce this list.",
  );
  expect(described).toEqual([recorded.writtenFirstTime.text]);
  // The reading, one line for each service, from a call that never saw the sentence.
  expect(view.getByText("What becomes reachable")).toBeTruthy();
  for (const line of reading.reachable)
    expect(view.getByText(line)).toBeTruthy();
  // The list and its mode, in the fields the admin saves from.
  const field = view.getByLabelText("Allowlist") as HTMLTextAreaElement;
  expect(field.value.split("\n")).toEqual(
    TRANSLATION.rules.map((rule) => rule.value),
  );
  expect(dialog.textContent).toContain("Team allowlist only");

  // Replayed as it stands, for the organization, once, after it rests.
  await waitFor(
    () =>
      expect(replayed).toEqual([
        {
          scopeKind: "organization",
          scopeId: "",
          mode: "allowlist_only",
          rules: TRANSLATION.rules,
          locked: false,
        },
      ]),
    { timeout: 3_000 },
  );
  await view.findByText(
    "Of the last 5 visits by Bots this policy applies to, this list would block 3 that are allowed today and would allow 1 that is blocked today.",
  );
  expect(dialog.textContent).toContain("www.linkedin.com");
  expect(dialog.textContent).toContain("2 visits by Ops Bot");
  expect(view.getAllByText("Would block")).toHaveLength(1);
  expect(view.getAllByText("Would allow")).toHaveLength(1);
  // What the replay can't see, said beside it.
  expect(dialog.textContent).toContain("Only page visits are recorded.");
  // Text beside the host rows runs full width: a Field holding their horizontal separators
  // balanced it into half-width lines.
  const headline = view.getByText(/^Of the last 5 visits/);
  expect(
    headline
      .closest("[data-slot=field]")
      ?.querySelector("[data-orientation=horizontal]") ?? null,
  ).toBeNull();
  // The body scrolls up and down only: Lock's switch, whose tap target reaches 12px past it, sat at
  // the right edge and gave the dialog a sideways scrollbar.
  expect(
    dialog
      .querySelector("[data-slot=dialog-body]")
      ?.classList.contains("overflow-x-hidden"),
  ).toBe(true);

  fireEvent.click(view.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(saved).toHaveLength(1));
  expect(saved[0]).toEqual({
    scopeKind: "organization",
    scopeId: "",
    mode: "allowlist_only",
    rules: TRANSLATION.rules,
    locked: false,
    authoring: { source: "english", text: recorded.writtenFirstTime.text },
  });
});

test("an edit after the list was written says the reading is for the written list", async () => {
  const { view } = await openOrganization();
  await userEvent.type(
    await view.findByLabelText("Describe the allowlist"),
    recorded.writtenFirstTime.text,
  );
  fireEvent.click(view.getByRole("button", { name: "Write list" }));
  await view.findByText("What becomes reachable");

  await userEvent.type(view.getByLabelText("Allowlist"), "\nslack.com");
  await view.findByText(
    "You've changed the list since it was written. The check and the reading above are for the written list, not your edit.",
  );
});

test("a domain's ports survive opening the policy and saving it unchanged, and an unchanged policy isn't replayed", async () => {
  const { view } = await openOrganization();
  const field = (await view.findByLabelText(
    "Allowlist",
  )) as HTMLTextAreaElement;
  expect(field.value).toBe("intranet.acme.example 8443\nhubspot.com");

  fireEvent.click(view.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(saved).toHaveLength(1));
  // It used to save `intranet.acme.example` alone, which allows every port.
  expect(saved[0]?.rules).toEqual(IN_FORCE.rules);
  expect(saved[0]).not.toHaveProperty("authoring");
  expect(replayed).toEqual([]);
});
