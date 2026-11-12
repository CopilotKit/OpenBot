import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, within } from "@testing-library/react";
import { SkillsSettingsPage } from "@/components/skills/skills-settings-page";
import { authKeys } from "@/lib/auth/queries";
import { browserKeys } from "@/lib/browser/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import { learningKeys } from "@/lib/learning/queries";
import { type PluginSkill, pluginKeys } from "@/lib/plugins/queries";
import { Route as CapabilitiesRoute } from "@/routes/_authed/_app/capabilities.index";
import { Route as CapabilitiesMemoryRoute } from "@/routes/_authed/_app/capabilities.memory";
import { Route as CapabilitiesSkillsRoute } from "@/routes/_authed/_app/capabilities.skills";
import { Route as LearningRoute } from "@/routes/_authed/settings/learning";
import { settleReactWork } from "./settle-react-work";

/**
 * Skills: the one page for "what does it know how to do?". The skills you wrote and the
 * ones your Bots learned are one list, each marked with how it was made.
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

const skill = (
  slug: string,
  title: string,
  ownerUserId: string | null,
): PluginSkill => ({
  id: slug,
  slug,
  ownerUserId,
  title,
  summary: `${title}, step by step.`,
  instructions: "Do it.",
  origin: "manual",
  installedBy: null,
  grantedTo: [],
  tools: [],
});

const refundOrder = {
  name: "refund-order",
  description: "Refunds an order.",
  open: false,
  approvedBy: null,
  sharing: "none",
};

function draw(
  edition: "team" | "personal",
  {
    browser = false,
    learning = true,
    written = true,
    learned = [refundOrder] as unknown[],
  } = {},
) {
  global.fetch = (async () =>
    Response.json({}, { status: 404 })) as unknown as typeof fetch;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    selfHostBanner: false,
    localEvaluation: edition === "personal",
    edition,
  });
  client.setQueryData(authKeys.currentUser(), {
    id: "me",
    name: "Maya",
    email: "maya@example.test",
    role: "user",
  });
  if (written) {
    client.setQueryData(pluginKeys.page(), {
      catalogue: [],
      servers: [],
      skills: [
        skill("weekly-report", "Weekly report", "me"),
        skill("onboarding", "Onboarding", null),
      ],
      botsMayCallBack: true,
    });
  }
  if (learning) {
    client.setQueryData(learningKeys.personal, {
      mode: "closed",
      sharingAllowed: true,
      skills: learned,
    });
  }
  client.setQueryData(learningKeys.review, {
    canReview: true,
    autoApprove: null,
    sources: [],
  });
  client.setQueryData(browserKeys.state, { available: browser });
  const root = createRootRoute();
  const page = createRoute({
    path: "/skills",
    getParentRoute: () => root,
    component: () => <SkillsSettingsPage creating={false} />,
  });
  const router = createRouter({
    routeTree: root.addChildren([page]),
    history: createMemoryHistory({ initialEntries: ["/skills"] }),
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

/** The card of rows under a section heading. */
function section(view: ReturnType<typeof draw>, heading: string) {
  const title = view.getByRole("heading", { name: heading });
  return title.closest("section") as HTMLElement;
}

test("your written and learned skills are one list, each marked with how it was made", async () => {
  const view = draw("team");
  await view.findByRole("heading", { name: "Skills" });
  const yours = section(view, "Your skills");
  const written = within(yours).getByText("Weekly report");
  expect(written.textContent).toContain("Written");
  const learned = within(yours).getByText("Refund order");
  expect(learned.textContent).toContain("Learned");
  // The admin's skill is not yours: it is under Workspace skills, unmarked and read-only.
  expect(within(yours).queryByText("Onboarding")).toBeNull();
  const workspace = section(view, "Workspace skills");
  expect(within(workspace).getByText("Onboarding")).toBeTruthy();
});

test("in the personal edition, the skills written for every Bot are yours too, and open their own page", async () => {
  const view = draw("personal");
  await view.findByRole("heading", { name: "Skills" });
  const yours = section(view, "Your skills");
  const everyBot = within(yours).getByText("Onboarding");
  expect(everyBot.textContent).toContain("Written");
  expect(everyBot.closest("a")?.getAttribute("href")).toBe(
    "/skills/onboarding",
  );
  expect(view.queryByRole("heading", { name: "Workspace skills" })).toBeNull();
});

test("New skill opens the side panel, and Teach a Bot is a row where a browser can run", async () => {
  const view = draw("team", { browser: true });
  await view.findByRole("heading", { name: "Skills" });
  expect(view.getByText("New skill").closest("a")?.getAttribute("href")).toBe(
    "/skills?new=true",
  );
  const teach = section(view, "Teach a Bot");
  expect(
    within(teach).getByText("Record a task").closest("a")?.getAttribute("href"),
  ).toBe("/browser");
});

test("in the personal edition, New skill opens the form whose skill has a switch per Bot", async () => {
  const view = draw("personal");
  await view.findByRole("heading", { name: "Skills" });
  expect(view.getByText("New skill").closest("a")?.getAttribute("href")).toBe(
    "/skills/new",
  );
});

test("no Teach a Bot row where OpenBot can't run a browser for you", async () => {
  const view = draw("team");
  await view.findByRole("heading", { name: "Skills" });
  expect(view.queryByRole("heading", { name: "Teach a Bot" })).toBeNull();
});

test("the skills you wrote and New skill stay when Learning can't be read", async () => {
  const view = draw("team", { learning: false });
  await view.findByRole("heading", { name: "Skills" });
  await view.findByText(
    "Couldn't load your Learning settings. Reload the page.",
  );
  const yours = section(view, "Your skills");
  expect(within(yours).getByText("Weekly report")).toBeTruthy();
  expect(view.getByText("New skill")).toBeTruthy();
  expect(view.queryByText(/No skills yet/)).toBeNull();
});

test("in the personal edition too, the skills you wrote and New skill stay when Learning can't be read", async () => {
  const view = draw("personal", { learning: false });
  await view.findByRole("heading", { name: "Skills" });
  await view.findByText(
    "Couldn't load your Learning settings. Reload the page.",
  );
  const yours = section(view, "Your skills");
  expect(within(yours).getByText("Weekly report")).toBeTruthy();
  expect(within(yours).getByText("Onboarding")).toBeTruthy();
  expect(view.getByText("New skill")).toBeTruthy();
  expect(view.queryByText(/No skills yet/)).toBeNull();
});

test("no empty state when the skills you wrote couldn't be read", async () => {
  const view = draw("team", { written: false });
  await view.findByText("Couldn't load the skills you wrote. Reload the page.");
  const yours = section(view, "Your skills");
  expect(within(yours).getByText("Refund order")).toBeTruthy();
  cleanup();

  const empty = draw("team", { written: false, learned: [] });
  await empty.findByText(
    "Couldn't load the skills you wrote. Reload the page.",
  );
  expect(empty.queryByText(/No skills yet/)).toBeNull();
});

function redirectOf(
  route: { options: { beforeLoad?: unknown } },
  input: unknown = {},
) {
  try {
    (route.options.beforeLoad as (input: unknown) => void)(input);
  } catch (thrown) {
    return (thrown as { options?: { to?: string; search?: unknown } }).options;
  }
  return undefined;
}

test("Capabilities and Learning open Skills and Memory", () => {
  expect(redirectOf(CapabilitiesRoute as never)?.to).toBe("/skills");
  expect(redirectOf(LearningRoute as never)?.to).toBe("/skills");
  expect(redirectOf(CapabilitiesMemoryRoute as never)?.to).toBe("/memory");
  // The side panel's state travels with the old address.
  expect(
    redirectOf(CapabilitiesSkillsRoute as never, {
      search: { edit: "weekly-report" },
    }),
  ).toMatchObject({
    to: "/skills",
    search: { edit: "weekly-report" },
  });
});
