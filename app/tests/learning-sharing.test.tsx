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
const sent: { path: string; method: string; body: unknown }[] = [];

beforeEach(() => {
  queryClient.clear();
  sent.length = 0;
  failRead = false;
  failWrite = false;
  answer = {
    mode: "closed",
    sharingAllowed: true,
    skills: [
      { name: "refund-order", description: "Refunds an order.", open: false },
      { name: "close-ticket", description: "Closes a ticket.", open: true },
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

test("closed is the default: Only my Bots is checked and no Skill list shows", async () => {
  const view = draw();
  await view.findByText("Only my Bots");
  expect(choice(view, "Only my Bots").getAttribute("aria-pressed")).toBe(
    "true",
  );
  expect(choice(view, "Everyone's Bots").getAttribute("aria-pressed")).toBe(
    "false",
  );
  expect(view.queryByText("Your Skills")).toBeNull();
  expect(view.queryByRole("switch")).toBeNull();
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
