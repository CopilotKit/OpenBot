import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { PersonalLearningSharing } from "@openbot/shared/learning";
import { environmentManager, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import {
  LearningSharing,
  SHARING_CHOICES,
} from "@/components/settings/learning-sharing";
import { queryClient } from "@/query-client";

let wasServer = true;
beforeAll(() => {
  GlobalRegistrator.register();
  wasServer = environmentManager.isServer();
  environmentManager.setIsServer(() => false);
});
afterAll(() => {
  environmentManager.setIsServer(() => wasServer);
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
let answer: PersonalLearningSharing;
let failRead = false;
let failWrite = false;
let edition: "team" | "personal" = "team";
const fetched: string[] = [];
const sent: { path: string; method: string; body: unknown }[] = [];

beforeEach(() => {
  queryClient.clear();
  sent.length = 0;
  fetched.length = 0;
  failRead = false;
  failWrite = false;
  edition = "team";
  answer = {
    mode: "closed",
    sharingAllowed: true,
    skills: [
      {
        name: "refund-order",
        description: "Refunds an order.",
        open: false,
        approvedBy: null,
        sharing: "none",
      },
      {
        name: "close-ticket",
        description: "Closes a ticket.",
        open: true,
        approvedBy: null,
        sharing: "none",
      },
    ],
  };
  global.fetch = Object.assign(
    async (path: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(path);
      const method = init?.method ?? "GET";
      if (method === "PUT") {
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        sent.push({ path: url, method, body });
        if (failWrite)
          return Response.json(
            { error: "Your Learning settings could not be saved." },
            { status: 503 },
          );
        if (url === "/api/settings/learning/mode")
          answer = { ...answer, mode: body.mode };
        const skill = /^\/api\/settings\/learning\/skills\/(.+)$/.exec(url);
        if (skill && answer.skills)
          answer = {
            ...answer,
            skills: answer.skills.map((entry) =>
              entry.name === decodeURIComponent(skill[1] ?? "")
                ? { ...entry, open: body.open }
                : entry,
            ),
          };
        return Response.json({ ok: true });
      }
      const detail = /^\/api\/settings\/learning\/skills\/(.+)$/.exec(url);
      if (detail) {
        const name = decodeURIComponent(detail[1] ?? "");
        fetched.push(url);
        return Response.json({
          skill: {
            name,
            description: "Refunds an order.",
            files: [
              {
                path: "SKILL.md",
                text: `---\nname: ${name}\n---\nStep one: look up the order.`,
              },
            ],
          },
        });
      }
      if (url === "/api/capabilities") return Response.json({ edition });
      if (url === "/api/settings/learning") {
        if (failRead) return new Response(null, { status: 500 });
        return Response.json(answer);
      }
      return new Response(null, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  cleanup();
  global.fetch = originalFetch;
});

function draw() {
  return render(
    <QueryClientProvider client={queryClient}>
      <LearningSharing />
    </QueryClientProvider>,
  );
}

/** The choice row whose title is `title`: one pressed button of three. */
const choice = (view: ReturnType<typeof draw>, title: string) =>
  choices(view).find((element) =>
    element.textContent?.includes(title),
  ) as HTMLElement;
const choices = (view: ReturnType<typeof draw>) =>
  view
    .getAllByRole("button")
    .filter((element) => element.hasAttribute("aria-pressed"));

test("three choices, each with one plain line saying who sees what", async () => {
  const view = draw();
  await view.findByText("Who else's Bots use your Skills");
  expect(choices(view)).toHaveLength(3);
  for (const choice of SHARING_CHOICES) {
    expect(view.getByText(choice.title)).toBeTruthy();
    expect(view.getByText(choice.description)).toBeTruthy();
  }
  expect(
    view.getByText("Only the Bots you use draw on your Skills."),
  ).toBeTruthy();
  expect(
    view.getByText("Every Bot on OpenBot draws on all of your Skills."),
  ).toBeTruthy();
});

test("closed is the default: Only my Bots is checked and your Skills are listed without switches", async () => {
  const view = draw();
  await view.findByText("Only my Bots");
  expect(choice(view, "Only my Bots").getAttribute("aria-pressed")).toBe(
    "true",
  );
  expect(choice(view, "Everyone's Bots").getAttribute("aria-pressed")).toBe(
    "false",
  );
  expect(view.getByText("Your Skills")).toBeTruthy();
  expect(view.getByText("refund-order")).toBeTruthy();
  expect(view.queryByRole("switch")).toBeNull();
});

test("Your Skills shows in every sharing mode", async () => {
  for (const mode of ["closed", "open", "choose"] as const) {
    queryClient.clear();
    answer = { ...answer, mode };
    const view = draw();
    await view.findByText("Your Skills");
    expect(view.getByText("refund-order")).toBeTruthy();
    expect(view.getByText("close-ticket")).toBeTruthy();
    expect(view.queryAllByRole("switch")).toHaveLength(
      mode === "choose" ? 2 : 0,
    );
    expect(view.getByText("Closes a ticket.", { exact: mode !== "choose" }));
    if (mode !== "choose") {
      expect(view.queryByText(/Every Bot may use it/)).toBeNull();
      expect(view.queryByText(/Only your Bots use it/)).toBeNull();
    }
    cleanup();
  }
});

test("choosing Everyone's Bots saves open at once", async () => {
  const view = draw();
  await view.findByText("Only my Bots");
  fireEvent.click(choice(view, "Everyone's Bots"));
  await waitFor(() =>
    expect(sent).toContainEqual({
      path: "/api/settings/learning/mode",
      method: "PUT",
      body: { mode: "open" },
    }),
  );
  await waitFor(() =>
    expect(choice(view, "Everyone's Bots").getAttribute("aria-pressed")).toBe(
      "true",
    ),
  );
});

test("pressing the choice already made saves nothing", async () => {
  const view = draw();
  await view.findByText("Only my Bots");
  fireEvent.click(choice(view, "Only my Bots"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(sent).toEqual([]);
});

test("under The Skills I choose, each Skill in your space has a switch that opens it to everyone", async () => {
  answer = { ...answer, mode: "choose" };
  const view = draw();
  await view.findByText("Your Skills");
  const refund = view.getByRole("switch", {
    name: "Open refund-order to everyone",
  });
  const close = view.getByRole("switch", {
    name: "Open close-ticket to everyone",
  });
  expect(refund.getAttribute("aria-checked")).toBe("false");
  expect(close.getAttribute("aria-checked")).toBe("true");
  expect(
    view.getByText(/Only your Bots use it\. Refunds an order\./),
  ).toBeTruthy();
  expect(
    view.getByText(/Every Bot may use it\. Closes a ticket\./),
  ).toBeTruthy();
  fireEvent.click(refund);
  await waitFor(() =>
    expect(sent).toContainEqual({
      path: "/api/settings/learning/skills/refund-order",
      method: "PUT",
      body: { open: true },
    }),
  );
  await waitFor(() =>
    expect(
      view
        .getByRole("switch", { name: "Open refund-order to everyone" })
        .getAttribute("aria-checked"),
    ).toBe("true"),
  );
});

test("a space with no Skills yet says so plainly", async () => {
  answer = { mode: "choose", sharingAllowed: true, skills: [] };
  const view = draw();
  await view.findByText(
    "No Skills learned from your recordings yet. Once there are, each one you open here reaches every Bot.",
  );
  expect(view.queryByRole("switch")).toBeNull();
});

test("Skills Intelligence did not deliver show a plain unavailable line, and the choice still works", async () => {
  answer = {
    mode: "choose",
    sharingAllowed: true,
    skills: null,
    unavailable: "unavailable",
  };
  const view = draw();
  await view.findByText(
    "Couldn't read your Skills from Intelligence just now. Your choice above still applies to them.",
  );
  fireEvent.click(choice(view, "Only my Bots"));
  await waitFor(() =>
    expect(sent).toContainEqual({
      path: "/api/settings/learning/mode",
      method: "PUT",
      body: { mode: "closed" },
    }),
  );
});

test("Automatic Learning off says no Skills are learned", async () => {
  answer = {
    mode: "choose",
    sharingAllowed: true,
    skills: null,
    unavailable: "off",
  };
  const view = draw();
  await view.findByText(
    "An admin has turned off Automatic Learning, so no Skills are learned from your recordings.",
  );
});

test("the personal edition says Automatic Learning is off instead of blaming Intelligence", async () => {
  edition = "personal";
  answer = { ...answer, skills: null, unavailable: "off" };
  const view = draw();
  await view.findByText(
    "Automatic Learning is turned off, so no Skills are learned yet. Turn it on in Admin.",
  );
  expect(view.queryByText(/Couldn't read/)).toBeNull();
});

test("until an admin turns on Skill sharing, it says so plainly and only Only my Bots can be chosen", async () => {
  answer = { ...answer, sharingAllowed: false };
  const view = draw();
  await view.findByText(
    "An admin hasn't turned on sharing Skills with every Bot, so only the Bots you use draw on yours.",
  );
  expect(choice(view, "Only my Bots").hasAttribute("disabled")).toBe(false);
  for (const title of ["Everyone's Bots", "The Skills I choose"]) {
    expect(choice(view, title).hasAttribute("disabled")).toBe(true);
    fireEvent.click(choice(view, title));
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(sent).toEqual([]);
});

test("a choice made before sharing was turned off says it applies again, and an open Skill can be closed but none opened", async () => {
  answer = { ...answer, mode: "choose", sharingAllowed: false };
  const view = draw();
  await view.findByText(
    "An admin hasn't turned on sharing Skills with every Bot, so only the Bots you use draw on yours. Your choice below applies again if an admin turns it on.",
  );
  const refund = view.getByRole("switch", {
    name: "Open refund-order to everyone",
  });
  const close = view.getByRole("switch", {
    name: "Open close-ticket to everyone",
  });
  expect(refund.hasAttribute("data-disabled")).toBe(true);
  expect(close.hasAttribute("data-disabled")).toBe(false);
  fireEvent.click(refund);
  fireEvent.click(close);
  await waitFor(() =>
    expect(sent).toEqual([
      {
        path: "/api/settings/learning/skills/close-ticket",
        method: "PUT",
        body: { open: false },
      },
    ]),
  );
});

test("a read that fails says so, and a save that fails says why", async () => {
  failRead = true;
  const failed = draw();
  await failed.findByText(
    "Couldn't load your Learning settings. Reload the page.",
  );
  cleanup();
  queryClient.clear();
  failRead = false;
  failWrite = true;
  const view = draw();
  await view.findByText("Only my Bots");
  fireEvent.click(choice(view, "Everyone's Bots"));
  await view.findByText("Your Learning settings could not be saved.");
});

test("each of Your Skills opens its SKILL.md", async () => {
  answer = { ...answer, mode: "choose" };
  const view = draw();
  await view.findByText("Your Skills");
  // Toggling the switch does not open the Skill.
  fireEvent.click(
    view.getByRole("switch", { name: "Open refund-order to everyone" }),
  );
  await waitFor(() => expect(sent).toHaveLength(1));
  expect(fetched).toEqual([]);
  expect(view.queryByText(/Step one: look up the order/)).toBeNull();
  // Pressing the row does.
  fireEvent.click(view.getByRole("button", { name: /refund-order/ }));
  await view.findByText(/Step one: look up the order/);
  expect(fetched).toEqual(["/api/settings/learning/skills/refund-order"]);
});

test("pressing a Your Skills row opens its SKILL.md where there is no switch", async () => {
  answer = { ...answer, mode: "closed" };
  const view = draw();
  await view.findByText("Your Skills");
  expect(view.queryByRole("switch")).toBeNull();
  fireEvent.click(view.getByRole("button", { name: /refund-order/ }));
  await view.findByText(/Step one: look up the order/);
  expect(fetched).toEqual(["/api/settings/learning/skills/refund-order"]);
});

test("a skill the person approved shows Ask to share instead of the Open switch", async () => {
  answer = {
    ...answer,
    mode: "choose",
    skills: [
      {
        name: "refund-order",
        description: "Refunds an order.",
        open: false,
        approvedBy: "person",
        sharing: "none",
      },
      {
        name: "close-ticket",
        description: "Closes a ticket.",
        open: true,
        approvedBy: "person",
        sharing: "requested",
      },
      {
        name: "reopen-ticket",
        description: "Reopens a ticket.",
        open: false,
        approvedBy: "admin",
        sharing: "none",
      },
    ],
  };
  const posts: string[] = [];
  const inner = global.fetch;
  global.fetch = Object.assign(
    async (path: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (init?.method === "POST") {
        posts.push(String(path));
        return Response.json({ ok: true });
      }
      return inner(path, init);
    },
    { preconnect: originalFetch.preconnect },
  );
  const view = draw();
  await view.findByText("refund-order");
  // Only the admin-approved skill keeps its switch.
  expect(view.getAllByRole("switch")).toHaveLength(1);
  expect(view.getByLabelText("Open reopen-ticket to everyone")).toBeTruthy();
  expect(view.getByText("Asked to share")).toBeTruthy();
  // Never "Every Bot may use it." for a skill an admin hasn't approved.
  expect(view.queryByText(/Every Bot may use it/)).toBeNull();
  expect(view.getAllByText(/Only your Bots use it/)).toHaveLength(3);
  fireEvent.click(view.getByRole("button", { name: "Ask to share" }));
  await waitFor(() =>
    expect(posts).toEqual([
      "/api/settings/learning/skills/refund-order/share-request",
    ]),
  );
  // In open mode the button replaces the row's chevron-only layout too.
  cleanup();
  queryClient.clear();
  answer = { ...answer, mode: "open" };
  const open = draw();
  await open.findByText("refund-order");
  expect(open.queryAllByRole("switch")).toHaveLength(0);
  expect(open.getByRole("button", { name: "Ask to share" })).toBeTruthy();
  // The row says so in open mode too: the skill stays with their own Bots.
  const refundRow = open.getByText("refund-order").closest("button");
  expect(refundRow?.textContent).toContain("Only your Bots use it.");
  const reopenRow = open.getByText("reopen-ticket").closest("div");
  expect(reopenRow?.textContent ?? "").not.toContain("Only your Bots use it.");
});

test("the personal edition lists Your Skills with no sharing choice and no switches", async () => {
  edition = "personal";
  answer = {
    ...answer,
    mode: "choose",
    skills: [
      {
        name: "refund-order",
        description: "Refunds an order.",
        open: false,
        approvedBy: "person",
        sharing: "none",
      },
      {
        name: "close-ticket",
        description: "Closes a ticket.",
        open: true,
        approvedBy: "admin",
        sharing: "approved",
      },
    ],
  };
  const view = draw();
  await view.findByText("Your Skills");
  await view.findByText("refund-order");
  expect(view.queryByText("Who else's Bots use your Skills")).toBeNull();
  expect(choices(view)).toHaveLength(0);
  expect(view.queryAllByRole("switch")).toHaveLength(0);
  expect(view.queryByRole("button", { name: "Ask to share" })).toBeNull();
  expect(view.queryByText(/Bots use it|Every Bot|Asked to share/)).toBeNull();
  expect(
    view.queryByText(/Only the Bots you use|Open a Skill to let/),
  ).toBeNull();
  fireEvent.click(view.getByRole("button", { name: /refund-order/ }));
  await view.findByText(/Step one: look up the order/);
  expect(fetched).toEqual(["/api/settings/learning/skills/refund-order"]);
});
