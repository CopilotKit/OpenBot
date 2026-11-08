import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type {
  LearnedSkillDetail,
  PersonalLearningSharing,
} from "@openbot/shared/learning";
import { environmentManager, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import {
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import { LearningSharing } from "@/components/settings/learning-sharing";
import { readableSkillBody, skillTitle } from "@/lib/learning/display";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/*
 * A skill Learning made from a recording, as Settings, Learning shows it on the personal edition with automatic approval
 * on. The skill is shaped as Intelligence publishes one: its name is the slug the SKILL.md front matter gives, its steps
 * carry the Recorder's selector note "(tag=a)", and the proposal that published it cites one of the person's
 * recordings. A person reads a title, the steps, and the recording it was learned from; never the slug, the file name or
 * the selector note.
 */

let wasServer = true;
beforeAll(() => {
  GlobalRegistrator.register();
  wasServer = environmentManager.isServer();
  environmentManager.setIsServer(() => false);
});
afterAll(async () => {
  await settleReactWork();
  environmentManager.setIsServer(() => wasServer);
  GlobalRegistrator.unregister();
});

const NAME = "example-domain-learnmore-navigation";
const DESCRIPTION =
  "Use when the user asks to visit the Example Domain site and follow its Learn more link. Do not use when the task targets a different website or link.";
const SKILL_MD = `---
name: ${NAME}
description: ${DESCRIPTION}
---

# Navigate example.com and follow Learn more link

## Instructions

1. Navigate to https://example.com/
2. On the homepage, click the 'Learn more' link (tag=a)
3. Confirm the page navigates to https://www.iana.org/help/example-domains; no retries or fallback handling are needed since this path has been reliable across 5 independent sessions
`;
const RECORDING = "0198a012-a20f-77c0-9e33-8992f18e74b0";
const RECORDING_TITLE = "Open example.com and follow Learn more";

const listing: PersonalLearningSharing = {
  mode: "closed",
  sharingAllowed: false,
  skills: [
    {
      name: NAME,
      description: DESCRIPTION,
      open: false,
      approvedBy: "person",
      sharing: "none",
    },
  ],
};
const detail: LearnedSkillDetail = {
  name: NAME,
  description: DESCRIPTION,
  files: [{ path: "SKILL.md", text: SKILL_MD }],
  recordings: [{ id: RECORDING, title: RECORDING_TITLE, available: true }],
};

const originalFetch = global.fetch;
beforeEach(() => {
  queryClient.clear();
  global.fetch = Object.assign(
    async (path: Parameters<typeof fetch>[0]) => {
      const url = String(path);
      if (url === "/api/capabilities")
        return Response.json({ edition: "personal" });
      if (url === "/api/settings/learning") return Response.json(listing);
      if (url === `/api/settings/learning/skills/${NAME}`)
        return Response.json({ skill: detail });
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
  const root = createRootRoute({ component: Outlet });
  const learning = createRoute({
    getParentRoute: () => root,
    path: "/settings/learning",
    component: LearningSharing,
  });
  const browser = createRoute({
    getParentRoute: () => root,
    path: "/browser",
    component: () => <p>Your recordings</p>,
  });
  const router = createRouter({
    routeTree: root.addChildren([learning, browser]),
    history: createMemoryHistory({ initialEntries: ["/settings/learning"] }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return { view, router };
}

test("Your skills names the skill in words, not by its slug", async () => {
  const { view } = draw();
  const row = await view.findByRole("button", {
    name: /Example domain learn more navigation/,
  });
  expect(row.textContent).toContain(DESCRIPTION);
  expect(view.queryByText(NAME)).toBeNull();
});

test("the skill's dialog shows its steps as content, the recording it came from, and no file name or selector note", async () => {
  const { view, router } = draw();
  fireEvent.click(
    await view.findByRole("button", {
      name: /Example domain learn more navigation/,
    }),
  );
  const dialog = within(await view.findByRole("dialog"));
  expect(
    dialog.getByRole("heading", {
      name: "Example domain learn more navigation",
    }),
  ).toBeTruthy();
  await dialog.findByText(/click the 'Learn more' link/);
  const text = (await view.findByRole("dialog")).textContent ?? "";
  expect(text).toContain("Navigate to");
  expect(text).not.toContain("SKILL.md");
  expect(text).not.toContain("(tag=");
  expect(text).not.toContain(NAME);

  // Learned from: the recording by its title, opening Your recordings on Teach a Bot.
  const recording = await dialog.findByRole("link", {
    name: new RegExp(RECORDING_TITLE),
  });
  expect(recording.getAttribute("href")).toBe("/browser?recordings=1");
  fireEvent.click(recording);
  await waitFor(() => expect(router.state.location.pathname).toBe("/browser"));
});

test("readable titles split and case a slug from the skill's own words", () => {
  expect(skillTitle(NAME, DESCRIPTION)).toBe(
    "Example domain learn more navigation",
  );
  expect(skillTitle("export-pdf-invoices", "Saves invoices as a PDF.")).toBe(
    "Export PDF invoices",
  );
  expect(skillTitle("github-issue-triage", "Sorts GitHub issues.")).toBe(
    "GitHub issue triage",
  );
  // A name that is already words stays as it is.
  expect(skillTitle("Refund triage", "Sorts refunds.")).toBe("Refund triage");
  expect(skillTitle("invoices")).toBe("Invoices");
});

test("selector notes are taken out of what a person reads, and only those", () => {
  const body = readableSkillBody(
    [
      "1. Click the 'Learn more' link (tag=a)",
      "2. Press Save [tag=button, id=save-button]",
      '3. Type the name (tag=input, name="customer name")',
      "4. Choose the plan `tag=select`",
      "5. Read the total (about $20) and keep it",
      "6. See [the docs](https://example.com) and (step 2)",
    ].join("\n"),
  );
  expect(body).toBe(
    [
      "1. Click the 'Learn more' link",
      "2. Press Save",
      "3. Type the name",
      "4. Choose the plan",
      "5. Read the total (about $20) and keep it",
      "6. See [the docs](https://example.com) and (step 2)",
    ].join("\n"),
  );
  // The stored text the Bot loads is not touched.
  expect(SKILL_MD).toContain("(tag=a)");
});
