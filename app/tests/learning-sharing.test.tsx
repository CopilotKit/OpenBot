import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { environmentManager, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import {
  LearningSharing,
  SHARING_CHOICES,
} from "@/components/settings/learning-sharing";
import type { PersonalLearningSharing } from "@/lib/learning/queries";
import { queryClient } from "@/query-client";
import { DEPLOYMENT_PATH } from "./admin-settings-api";
import {
  learningContract,
  personLearning,
  personLearningBody,
  problem,
  requestOf,
  served,
} from "./learning-api";

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
/** The person's own Learning, as the API answers it. Automatic approval is the personal edition's alone. */
type Answer = Omit<PersonalLearningSharing, "autoApprove">;
const ME = personLearning();
/** Where each of the person's learned skills is read and opened, by its name after this. */
const SKILLS = ME.learnedSkill("");
let answer: Answer;
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
      const request = requestOf(path, init);
      const skill = request.path.startsWith(SKILLS)
        ? decodeURIComponent(request.path.slice(SKILLS.length))
        : null;
      if (request.method === "PATCH") {
        const body = request.body ?? {};
        sent.push({ path: request.path, method: request.method, body });
        if (failWrite)
          return problem(
            500,
            "Your Learning settings could not be saved.",
            "INTERNAL_ERROR",
          );
        if (request.path === ME.settings) {
          answer = { ...answer, mode: body.mode as Answer["mode"] };
          return served(learningContract.UpdatePersonLearningSettingsResponse, {
            mode: answer.mode,
            autoApprove: null,
          });
        }
        if (skill !== null && answer.skills) {
          answer = {
            ...answer,
            skills: answer.skills.map((entry) =>
              entry.name === skill
                ? { ...entry, open: body.open as boolean }
                : entry,
            ),
          };
          return served(learningContract.UpdateLearnedSkillResponse, {
            name: skill,
            open: body.open,
          });
        }
        return problem(404, "This skill doesn't exist.", "NOT_FOUND");
      }
      if (skill !== null && request.method === "GET") {
        fetched.push(request.path);
        return served(learningContract.GetLearnedSkillResponse, {
          name: skill,
          description: "Refunds an order.",
          files: [
            {
              path: "SKILL.md",
              text: `---\nname: ${skill}\n---\nStep one: look up the order.`,
            },
          ],
        });
      }
      if (url === DEPLOYMENT_PATH) return Response.json({ edition });
      if (request.path === ME.settings) {
        // A server that broke and said nothing: the screen's own sentence is what reaches the person.
        if (failRead) return new Response(null, { status: 500 });
        return served(
          learningContract.GetPersonLearningSettingsResponse,
          personLearningBody(answer),
        );
      }
      return problem(404, "Not found.", "NOT_FOUND");
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
  await view.findByText("Who else's Bots use your skills");
  expect(choices(view)).toHaveLength(3);
  for (const choice of SHARING_CHOICES) {
    expect(view.getByText(choice.title)).toBeTruthy();
    expect(view.getByText(choice.description)).toBeTruthy();
  }
  expect(
    view.getByText("Only the Bots you use draw on your skills."),
  ).toBeTruthy();
  expect(
    view.getByText("Every Bot on OpenBot draws on all of your skills."),
  ).toBeTruthy();
});

test("closed is the default: Only my Bots is checked and your skills are listed without switches", async () => {
  const view = draw();
  await view.findByText("Only my Bots");
  expect(choice(view, "Only my Bots").getAttribute("aria-pressed")).toBe(
    "true",
  );
  expect(choice(view, "Everyone's Bots").getAttribute("aria-pressed")).toBe(
    "false",
  );
  expect(view.getByText("Your skills")).toBeTruthy();
  expect(view.getByText("Refund order")).toBeTruthy();
  expect(view.queryByRole("switch")).toBeNull();
});

test("Your skills shows in every sharing mode", async () => {
  for (const mode of ["closed", "open", "choose"] as const) {
    queryClient.clear();
    answer = { ...answer, mode };
    const view = draw();
    await view.findByText("Your skills");
    expect(view.getByText("Refund order")).toBeTruthy();
    expect(view.getByText("Close ticket")).toBeTruthy();
    expect(view.queryAllByRole("switch")).toHaveLength(
      mode === "choose" ? 2 : 0,
    );
    expect(
      view.getByText("Closes a ticket.", { exact: mode !== "choose" }),
    ).toBeTruthy();
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
      path: ME.settings,
      method: "PATCH",
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

test("under The skills I choose, each skill in your space has a switch that opens it to everyone", async () => {
  answer = { ...answer, mode: "choose" };
  const view = draw();
  await view.findByText("Your skills");
  const refund = view.getByRole("switch", {
    name: "Open Refund order to everyone",
  });
  const close = view.getByRole("switch", {
    name: "Open Close ticket to everyone",
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
      path: ME.learnedSkill("refund-order"),
      method: "PATCH",
      body: { open: true },
    }),
  );
  await waitFor(() =>
    expect(
      view
        .getByRole("switch", { name: "Open Refund order to everyone" })
        .getAttribute("aria-checked"),
    ).toBe("true"),
  );
});

test("a space with no skills yet says so plainly", async () => {
  answer = { mode: "choose", sharingAllowed: true, skills: [] };
  const view = draw();
  await view.findByText(
    "No skills yet. Write one with New skill, or teach a Bot a task.",
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
    "Couldn't read your skills just now. Your choice below still applies to them.",
  );
  fireEvent.click(choice(view, "Only my Bots"));
  await waitFor(() =>
    expect(sent).toContainEqual({
      path: ME.settings,
      method: "PATCH",
      body: { mode: "closed" },
    }),
  );
});

test("Automatic learning off says no skills are learned", async () => {
  answer = {
    mode: "choose",
    sharingAllowed: true,
    skills: null,
    unavailable: "off",
  };
  const view = draw();
  await view.findByText(
    "An admin has turned off automatic learning, so no skills are learned from your recordings.",
  );
});

test("until an admin turns on skill sharing, it says so plainly and only Only my Bots can be chosen", async () => {
  answer = { ...answer, sharingAllowed: false };
  const view = draw();
  await view.findByText(
    "An admin hasn't turned on sharing skills with every Bot, so only the Bots you use draw on yours.",
  );
  expect(choice(view, "Only my Bots").hasAttribute("disabled")).toBe(false);
  for (const title of ["Everyone's Bots", "The skills I choose"]) {
    expect(choice(view, title).hasAttribute("disabled")).toBe(true);
    fireEvent.click(choice(view, title));
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(sent).toEqual([]);
});

test("a choice made before sharing was turned off says it applies again, and an open skill can be closed but none opened", async () => {
  answer = { ...answer, mode: "choose", sharingAllowed: false };
  const view = draw();
  await view.findByText(
    "An admin hasn't turned on sharing skills with every Bot, so only the Bots you use draw on yours. Your choice below applies again if an admin turns it on.",
  );
  const refund = view.getByRole("switch", {
    name: "Open Refund order to everyone",
  });
  const close = view.getByRole("switch", {
    name: "Open Close ticket to everyone",
  });
  expect(refund.hasAttribute("data-disabled")).toBe(true);
  expect(close.hasAttribute("data-disabled")).toBe(false);
  fireEvent.click(refund);
  fireEvent.click(close);
  await waitFor(() =>
    expect(sent).toEqual([
      {
        path: ME.learnedSkill("close-ticket"),
        method: "PATCH",
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

test("each of Your skills opens its SKILL.md", async () => {
  answer = { ...answer, mode: "choose" };
  const view = draw();
  await view.findByText("Your skills");
  // Toggling the switch does not open the Skill.
  fireEvent.click(
    view.getByRole("switch", { name: "Open Refund order to everyone" }),
  );
  await waitFor(() => expect(sent).toHaveLength(1));
  expect(fetched).toEqual([]);
  expect(view.queryByText(/Step one: look up the order/)).toBeNull();
  // Pressing the row does.
  fireEvent.click(view.getByRole("button", { name: /Refund order/ }));
  await view.findByText(/Step one: look up the order/);
  expect(fetched).toEqual([ME.learnedSkill("refund-order")]);
});

test("pressing a Your skills row opens its SKILL.md where there is no switch", async () => {
  answer = { ...answer, mode: "closed" };
  const view = draw();
  await view.findByText("Your skills");
  expect(view.queryByRole("switch")).toBeNull();
  fireEvent.click(view.getByRole("button", { name: /Refund order/ }));
  await view.findByText(/Step one: look up the order/);
  expect(fetched).toEqual([ME.learnedSkill("refund-order")]);
});

/** Fetch stub that records POSTs, on top of the default one. */
function recordPosts() {
  const posts: string[] = [];
  const inner = global.fetch;
  global.fetch = Object.assign(
    async (path: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (init?.method === "POST") {
        const request = requestOf(path, init);
        posts.push(request.path);
        return served(learningContract.RequestSkillSharingResponse, {
          skillName: decodeURIComponent(
            request.path.slice(SKILLS.length, -"/share".length),
          ),
          sharing: "requested",
        });
      }
      return inner(path, init);
    },
    { preconnect: originalFetch.preconnect },
  );
  return posts;
}

const approvedByPerson = (
  name: string,
  open: boolean,
  sharing: "none" | "requested" | "approved" | "declined",
) => ({
  name,
  description: `${name} description.`,
  open,
  approvedBy: "person" as const,
  sharing,
});

test("under Everyone's Bots, a skill waiting for an admin has one control: Ask to share", async () => {
  answer = {
    ...answer,
    mode: "open",
    skills: [
      approvedByPerson("refund-order", false, "none"),
      approvedByPerson("close-ticket", true, "requested"),
      {
        name: "reopen-ticket",
        description: "Reopens a ticket.",
        open: false,
        approvedBy: "admin",
        sharing: "none",
      },
    ],
  };
  const posts = recordPosts();
  const view = draw();
  await view.findByText("Refund order");
  expect(view.queryAllByRole("switch")).toHaveLength(0);
  expect(view.getAllByRole("button", { name: "Ask to share" })).toHaveLength(1);
  expect(view.getByText("Asked to share")).toBeTruthy();
  const refundRow = view.getByText("Refund order").closest("button");
  expect(refundRow?.textContent).toContain("Only your Bots use it.");
  // Scoped to the row itself: the title div's own closest("div") would be the title.
  const reopenRow = view
    .getByText("Reopen ticket")
    .closest('[data-slot="item"]') as HTMLElement;
  expect(reopenRow.textContent).toContain("Reopens a ticket.");
  expect(reopenRow.textContent).not.toContain("Only your Bots use it.");
  fireEvent.click(view.getByRole("button", { name: "Ask to share" }));
  await waitFor(() => expect(posts).toEqual([ME.share("refund-order")]));
});

test("under The skills I choose, every skill keeps its switch, including ones waiting for an admin", async () => {
  answer = {
    ...answer,
    mode: "choose",
    skills: [
      approvedByPerson("refund-order", false, "none"),
      approvedByPerson("close-ticket", true, "requested"),
      {
        name: "reopen-ticket",
        description: "Reopens a ticket.",
        open: false,
        approvedBy: "admin",
        sharing: "none",
      },
    ],
  };
  const view = draw();
  await view.findByText("Refund order");
  expect(view.getAllByRole("switch")).toHaveLength(3);
  expect(view.queryByRole("button", { name: "Ask to share" })).toBeNull();
  expect(view.getByText("Asked to share")).toBeTruthy();
  expect(view.queryByText(/Every Bot may use it/)).toBeNull();
  expect(view.getAllByText(/Only your Bots use it/)).toHaveLength(3);
});

test("an open skill waiting for an admin can be closed", async () => {
  answer = {
    ...answer,
    mode: "choose",
    skills: [approvedByPerson("close-ticket", true, "none")],
  };
  const view = draw();
  const toggle = await view.findByRole("switch", {
    name: "Open Close ticket to everyone",
  });
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  fireEvent.click(toggle);
  await waitFor(() =>
    expect(sent).toEqual([
      {
        path: ME.learnedSkill("close-ticket"),
        method: "PATCH",
        body: { open: false },
      },
    ]),
  );
});

test("switching on a skill waiting for an admin opens it and asks to share", async () => {
  answer = {
    ...answer,
    mode: "choose",
    skills: [approvedByPerson("refund-order", false, "none")],
  };
  const posts = recordPosts();
  const view = draw();
  fireEvent.click(
    await view.findByRole("switch", { name: "Open Refund order to everyone" }),
  );
  await waitFor(() => expect(posts).toEqual([ME.share("refund-order")]));
  expect(sent).toEqual([
    {
      path: ME.learnedSkill("refund-order"),
      method: "PATCH",
      body: { open: true },
    },
  ]);
});

test("a skill already asked about is switched on without a second request", async () => {
  answer = {
    ...answer,
    mode: "choose",
    skills: [approvedByPerson("refund-order", false, "requested")],
  };
  const posts = recordPosts();
  const view = draw();
  fireEvent.click(
    await view.findByRole("switch", { name: "Open Refund order to everyone" }),
  );
  await waitFor(() => expect(sent).toHaveLength(1));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(posts).toEqual([]);
});

test("while an admin has sharing off, Your skills says only your Bots use them, whatever the saved mode", async () => {
  for (const mode of ["open", "choose"] as const) {
    queryClient.clear();
    answer = { ...answer, mode, sharingAllowed: false };
    const view = draw();
    await view.findByText("Your skills");
    expect(
      view.getByText("Only the Bots you use draw on these skills."),
    ).toBeTruthy();
    expect(view.queryByText(/Every Bot on OpenBot draws on these/)).toBeNull();
    expect(view.queryByText(/Open a skill to let every Bot/)).toBeNull();
    expect(view.queryByText(/Every Bot may use it/)).toBeNull();
    if (mode === "choose")
      expect(view.getAllByText(/Only your Bots use it/)).toHaveLength(2);
    cleanup();
  }
});

test("the personal edition lists Your skills with no sharing choice and no switches", async () => {
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
  await view.findByText("Your skills");
  await view.findByText("Refund order");
  expect(view.queryByText("Who else's Bots use your skills")).toBeNull();
  expect(choices(view)).toHaveLength(0);
  expect(view.queryAllByRole("switch")).toHaveLength(0);
  expect(view.queryByRole("button", { name: "Ask to share" })).toBeNull();
  expect(view.queryByText(/Bots use it|Every Bot|Asked to share/)).toBeNull();
  expect(
    view.queryByText(/Only the Bots you use|Open a skill to let/),
  ).toBeNull();
  fireEvent.click(view.getByRole("button", { name: /Refund order/ }));
  await view.findByText(/Step one: look up the order/);
  expect(fetched).toEqual([ME.learnedSkill("refund-order")]);
});
