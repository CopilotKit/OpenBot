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
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { SetupChecklist, summaryOf } from "@/components/setup/setup-checklist";
import type {
  SetupChecklist as Checklist,
  SetupRow,
} from "@/lib/setup/queries";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/**
 * The setup checklist Settings → Setup draws. It draws what the server decided, row by row, and
 * lets somebody check again and open the page that closes a gap.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost:3010" }));
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = globalThis.fetch;
let answer: () => Response;
/** What `POST /api/setup/check` does before the read it causes; nothing by default. */
let onCheck: (() => void) | null;
let requests: { path: string; method: string }[];
const defaults = queryClient.getDefaultOptions();

beforeEach(() => {
  queryClient.clear();
  queryClient.setDefaultOptions({
    ...defaults,
    queries: { ...defaults.queries, retry: false },
  });
  requests = [];
  onCheck = null;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? "GET";
      requests.push({ path, method });
      if (path === "/api/setup/check") onCheck?.();
      return answer();
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  queryClient.setDefaultOptions(defaults);
  globalThis.fetch = originalFetch;
});

const ROW = (row: Partial<SetupRow> & Pick<SetupRow, "id">): SetupRow => ({
  scope: "deployment",
  title: row.id,
  required: false,
  status: row.ready === false ? "needs_setup" : "ready",
  ready: true,
  detail: "Works.",
  fix: null,
  ...row,
});

/** What an admin is sent: Intelligence ready, the model key missing, no computer, Slack unset. */
const ADMIN: Checklist = {
  audience: "admin",
  rows: [
    ROW({
      id: "intelligence",
      title: "Backend",
      required: true,
      detail: "Keeps your conversations and what OpenBot remembers.",
    }),
    ROW({
      id: "model",
      title: "AI model",
      required: true,
      ready: false,
      detail: "Without a model key, OpenBot can't answer.",
      fix: {
        kind: "env",
        names: ["OPENAI_API_KEY"],
        docsUrl: "https://github.com/CopilotKit/openbot#quick-start",
        page: { label: "Credentials", path: "/admin/credentials" },
      },
    }),
    ROW({
      id: "computer",
      title: "Bot computer",
      ready: false,
      detail: "Without it, Bots can't browse the web or work with files.",
      fix: {
        kind: "env",
        names: ["AGENT_COMPUTER_URL", "COMPUTER_TOKEN"],
        docsUrl:
          "https://github.com/CopilotKit/openbot/blob/main/docs/configuration.md#computer-and-supervisor",
      },
    }),
    ROW({ id: "apps", title: "More apps" }),
    ROW({
      id: "chat",
      title: "Slack and Teams",
      ready: false,
      detail: "Without it, people can talk to OpenBot only here.",
      fix: {
        kind: "env",
        names: ["OPENTAG_SHARED_SECRET", "OPENTAG_URL"],
        docsUrl:
          "https://github.com/CopilotKit/openbot/blob/main/docs/configuration.md",
      },
    }),
  ],
};

/** What a member is sent for the same deployment: no fix, and no names. */
const MEMBER: Checklist = {
  audience: "member",
  rows: ADMIN.rows.map((row) =>
    row.ready ? row : { ...row, detail: "Your admin sets this up.", fix: null },
  ),
};

function serving(checklist: Checklist) {
  answer = () => Response.json({ checklist });
}

function draw() {
  const opened: Array<{ label: string; path: string }> = [];
  const view = render(
    <QueryClientProvider client={queryClient}>
      <SetupChecklist openPage={(target) => opened.push(target)} />
    </QueryClientProvider>,
  );
  return Object.assign(view, { opened });
}

const rowOf = (view: ReturnType<typeof render>, id: string) => {
  const row = view.container.querySelector<HTMLElement>(
    `[data-setup-row="${id}"]`,
  );
  if (!row) throw new Error(`no ${id} row`);
  return within(row);
};

test("Ready and Needs setup rows come from the server's answer", async () => {
  serving(ADMIN);
  const view = draw();

  await view.findByRole("list", { name: "Setup" });
  expect(
    Array.from(view.container.querySelectorAll("[data-setup-row]")).map((row) =>
      row.getAttribute("data-setup-row"),
    ),
  ).toEqual(["intelligence", "model", "computer", "apps", "chat"]);
  expect(rowOf(view, "intelligence").getByText("Ready")).not.toBeNull();
  expect(rowOf(view, "model").getByText("Needs setup")).not.toBeNull();
  expect(rowOf(view, "model").getByText("Required")).not.toBeNull();
  expect(
    rowOf(view, "model").getByText(
      "Without a model key, OpenBot can't answer.",
    ),
  ).not.toBeNull();
  expect(
    view.getByText(
      "3 things need setup, and 1 is required. Set up the required one first.",
    ),
  ).not.toBeNull();
});

test("a required gap is red, an optional one amber, and Ready green", async () => {
  serving(ADMIN);
  const view = draw();
  await view.findByRole("list", { name: "Setup" });

  expect(rowOf(view, "model").getByText("Needs setup").className).toContain(
    "text-destructive",
  );
  expect(rowOf(view, "chat").getByText("Needs setup").className).toContain(
    "text-amber-600",
  );
  expect(rowOf(view, "apps").getByText("Ready").className).toContain(
    "text-emerald-600",
  );
});

test("an admin is shown the variable to set, the page, and the guide", async () => {
  serving(ADMIN);
  const view = draw();
  await view.findByRole("list", { name: "Setup" });

  const model = rowOf(view, "model");
  expect(model.getByText("OPENAI_API_KEY")).not.toBeNull();
  const guide = model.getByRole("link", { name: "Setup guide" });
  expect(guide.getAttribute("href")).toBe(
    "https://github.com/CopilotKit/openbot#quick-start",
  );
  expect(guide.getAttribute("target")).toBe("_blank");

  fireEvent.click(model.getByRole("link", { name: "Credentials" }));
  expect(view.opened).toEqual([
    { label: "Credentials", path: "/admin/credentials" },
  ]);

  expect(rowOf(view, "chat").getByText("OPENTAG_SHARED_SECRET")).not.toBeNull();
});

test("a fix's links show a full-strength focus ring", async () => {
  serving(ADMIN);
  const view = draw();
  await view.findByRole("list", { name: "Setup" });

  for (const link of rowOf(view, "model").getAllByRole("link")) {
    expect(link.className).toContain("focus-visible:ring-ring");
    expect(link.className).not.toContain("ring-ring/50");
  }
});

test("a member sees their admin sets it up, and no variable names", async () => {
  serving(MEMBER);
  const view = draw();
  await view.findByRole("list", { name: "Setup" });

  const model = rowOf(view, "model");
  expect(model.getByText("Your admin sets this up.")).not.toBeNull();
  expect(view.container.textContent).not.toContain("OPENAI_API_KEY");
  expect(view.container.textContent).not.toContain("OPENTAG");
  expect(view.queryByRole("link", { name: "Setup guide" })).toBeNull();
  expect(view.queryByRole("link")).toBeNull();
});

test("a member's gaps are one neutral line: no amber or red pill, no Required, no counts", async () => {
  serving(MEMBER);
  const view = draw();
  await view.findByRole("list", { name: "Setup" });

  for (const id of ["model", "computer", "chat"]) {
    const row = rowOf(view, id);
    expect(row.queryByText("Needs setup")).toBeNull();
    expect(row.queryByText("Required")).toBeNull();
    expect(row.getByText("Your admin sets this up.")).not.toBeNull();
  }
  const list = view.getByRole("list", { name: "Setup" });
  expect(list.innerHTML).not.toContain("text-destructive");
  expect(list.innerHTML).not.toContain("text-amber-600");
  // What works still says so.
  expect(rowOf(view, "intelligence").getByText("Ready")).not.toBeNull();
  expect(view.getByRole("status").textContent).toBe(
    "Your admin sets up anything that isn't ready yet.",
  );
});

test("while the answer is on its way, the checklist draws nothing", async () => {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  globalThis.fetch = Object.assign(
    async () => {
      await held;
      return Response.json({ checklist: ADMIN });
    },
    { preconnect: originalFetch.preconnect },
  );
  const view = draw();

  expect(view.queryByRole("status")).toBeNull();
  expect(view.queryByRole("list", { name: "Setup" })).toBeNull();
  release();
  await view.findByRole("list", { name: "Setup" });
});

test("Check again asks the server to check again, and draws its answer", async () => {
  serving(ADMIN);
  const view = draw();
  await view.findByRole("list", { name: "Setup" });

  onCheck = () => {
    serving({
      audience: "admin",
      rows: ADMIN.rows.map((row) => ({
        ...row,
        status: "ready",
        ready: true,
        fix: null,
      })),
    });
  };
  fireEvent.click(view.getByRole("button", { name: "Check again" }));

  expect(await view.findByText("Everything is set up.")).not.toBeNull();
  expect(requests).toContainEqual({ path: "/api/setup/check", method: "POST" });
});

test("a key nobody has checked reads Not checked, never Ready", async () => {
  serving({
    audience: "admin",
    rows: ADMIN.rows.map((row) =>
      row.id === "model"
        ? {
            ...row,
            status: "not_checked",
            ready: false,
            detail: "Key set, not checked yet. Check again to ask OpenAI.",
            fix: null,
          }
        : { ...row, status: "ready", ready: true, fix: null },
    ),
  });
  const view = draw();
  await view.findByRole("list", { name: "Setup" });

  const model = rowOf(view, "model");
  expect(model.getByText("Not checked")).not.toBeNull();
  expect(model.queryByText("Ready")).toBeNull();
  expect(view.getByText("1 thing isn't checked yet.")).not.toBeNull();
});

test("optional gaps alone say OpenBot is ready, and that each says how to add it", async () => {
  serving({
    audience: "admin",
    rows: ADMIN.rows.map((row) =>
      row.required ? { ...row, status: "ready", ready: true, fix: null } : row,
    ),
  });
  const view = draw();

  expect(
    await view.findByText(
      "OpenBot is ready to use. 2 optional features aren't set up yet. Each says how to add it.",
    ),
  ).not.toBeNull();
});

test("the summary counts in the singular and the plural", () => {
  const gap = (id: SetupRow["id"], required = false) =>
    ROW({ id, required, ready: false, status: "needs_setup" });
  expect(summaryOf([gap("chat")])).toBe(
    "OpenBot is ready to use. 1 optional feature isn't set up yet. Each says how to add it.",
  );
  expect(summaryOf([gap("model", true), gap("intelligence", true)])).toBe(
    "2 things need setup, and 2 are required. Set up the required ones first.",
  );
  expect(summaryOf([gap("model", true)])).toBe(
    "1 thing needs setup, and 1 is required. Set up the required one first.",
  );
});

test("a check that fails says so, and Check again stays", async () => {
  answer = () => Response.json({ error: "nope" }, { status: 503 });
  const view = draw();

  expect(
    await view.findByText("Couldn't check your setup. Check again."),
  ).not.toBeNull();
  expect(view.getByRole("button", { name: "Check again" })).not.toBeNull();
});
