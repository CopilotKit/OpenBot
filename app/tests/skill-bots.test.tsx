import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { SkillsSections } from "@/components/bot-profile/access";
import {
  botsFromPicks,
  SkillBotsDialog,
  skillBotsSummary,
} from "@/components/skills/skill-bots";
import { type AgentProfile, agentListQueryOptions } from "@/lib/agents/queries";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import {
  type DeploymentCapabilities,
  deploymentCapabilitiesQueryOptions,
} from "@/lib/deployment/queries";
import { agentPluginsQueryOptions } from "@/lib/plugins/queries";
import { type Skill, skillListQueryOptions } from "@/lib/skills/queries";
import { botGrantsPath } from "./bot-grants-api";
import { settleReactWork } from "./settle-react-work";
import { skillBody } from "./skills-api";

/*
 * Which Bots use a skill, in OpenBot Personal: every Bot (Bots made later included), or only the
 * ones chosen, where choosing none is every Bot. A Bot's page adds several skills at once, says
 * where else each is, and can make one its own.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(() => cleanup());
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

const bot = (id: string, name: string): AgentProfile => ({
  assignedToMe: false,
  runsOnOpenBotModel: false,
  keyFromOpenBot: false,
  id,
  name,
  title: "",
  roleDescription: "",
  avatarSeed: id,
  visibility: "private",
  endpoint: null,
  builtIn: true,
  hasAuth: false,
  hasCallbackToken: false,
  isolated: false,
  isolationActive: false,
  isolationOffReason: null,
  hidden: false,
  pinned: false,
  systemOwned: false,
  canManage: true,
  mine: true,
});
const ASSISTANT = bot("assistant", "Assistant");
const CODER = bot("coder", "Coder");
const WRITER = bot("writer", "Writer");
const BOTS = [ASSISTANT, CODER, WRITER];

const skill = (
  slug: string,
  grantedTo: string[],
  everyBot = false,
  title = slug,
): Skill => ({
  id: slug,
  slug,
  ownerUserId: "me",
  title,
  summary: "",
  instructions: "Do it.",
  grantedTo,
  everyBot,
  tools: [],
  usableOnYourBots: true,
});

/** Every write the page sends, as `METHOD path body`, answered with the skill it was about. */
function serving(): string[] {
  const sent: string[] = [];
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://127.0.0.1");
    const method = init?.method ?? "GET";
    if (method !== "GET")
      sent.push(`${method} ${url.pathname} ${init?.body ?? ""}`);
    if (url.pathname.endsWith("/bots") && method === "PUT")
      return Response.json(skillBody({ slug: "standup" }));
    return Response.json({
      id: "skill:x",
      kind: "skill",
      ref: "x",
      action: null,
      skill: null,
    });
  }) as unknown as typeof fetch;
  return sent;
}

function withData(
  children: ReactNode,
  data: { skills: Skill[]; held?: string[]; personal?: boolean },
) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  client.setQueryData(agentListQueryOptions().queryKey, BOTS);
  client.setQueryData(agentListQueryOptions(true).queryKey, []);
  client.setQueryData(skillListQueryOptions().queryKey, data.skills);
  client.setQueryData(currentUserQueryOptions().queryKey, {
    id: "me",
  } as never);
  client.setQueryData(deploymentCapabilitiesQueryOptions().queryKey, {
    edition: data.personal === false ? "team" : "personal",
  } as DeploymentCapabilities);
  client.setQueryData(agentPluginsQueryOptions(ASSISTANT.id).queryKey, {
    tools: [],
    skills: (data.held ?? []).map((slug) => ({
      slug,
      title: slug,
      summary: "",
    })),
  });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({ component: () => <>{children}</> }),
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

describe("what a skill's Bots are called", () => {
  test("every Bot, one, two, or one and how many more", () => {
    expect(skillBotsSummary(skill("a", ["coder"], true), BOTS)).toBe(
      "Every Bot",
    );
    expect(skillBotsSummary(skill("a", ["coder"]), BOTS)).toBe("Coder");
    expect(skillBotsSummary(skill("a", ["coder", "writer"]), BOTS)).toBe(
      "Coder and Writer",
    );
    expect(
      skillBotsSummary(
        skill(
          "a",
          BOTS.map((one) => one.id),
        ),
        BOTS,
      ),
    ).toBe("Assistant and 2 more");
    expect(skillBotsSummary(skill("a", []), BOTS)).toBe("No Bots");
  });

  test("choosing none is every Bot", () => {
    expect(botsFromPicks(new Set())).toEqual({ everyBot: true });
    expect(botsFromPicks(new Set(["coder"]))).toEqual({
      everyBot: false,
      botIds: ["coder"],
    });
  });
});

describe("choosing a skill's Bots", () => {
  test("a skill on every Bot can be given to only one", async () => {
    const sent = serving();
    const view = withData(
      <SkillBotsDialog
        bots={BOTS}
        onClose={() => {}}
        skill={skill("standup", ["assistant", "coder", "writer"], true)}
      />,
      { skills: [] },
    );
    expect(
      await view.findByText(
        /Every Bot uses it, including Bots you make later\./,
      ),
    ).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Coder" }));
    expect(view.getByText(/Only Coder uses it\./)).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toContain("/skills/standup/bots");
    expect(JSON.parse(sent[0]?.split(" ").slice(2).join(" ") ?? "")).toEqual({
      everyBot: false,
      botIds: ["coder"],
    });
  });

  test("taking every Bot off it puts it back on every Bot", async () => {
    const sent = serving();
    const view = withData(
      <SkillBotsDialog
        bots={BOTS}
        onClose={() => {}}
        skill={skill("standup", ["coder"])}
      />,
      { skills: [] },
    );
    fireEvent.click(await view.findByRole("button", { name: "Coder" }));
    fireEvent.click(view.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toContain('"everyBot":true');
  });
});

describe("a Bot's own skills, in OpenBot Personal", () => {
  const skills = [
    skill(
      "standup",
      BOTS.map((one) => one.id),
      true,
      "Standup",
    ),
    skill("review", ["assistant", "coder"], false, "Review"),
    skill("draft", ["writer"], false, "Draft"),
    skill("notes", [], false, "Notes"),
  ];

  test("each says where else it is", async () => {
    serving();
    const view = withData(<SkillsSections agent={ASSISTANT} />, {
      skills,
      held: ["standup", "review"],
    });
    expect(await view.findByText("Every Bot")).toBeTruthy();
    expect(view.getByText("Also on Coder")).toBeTruthy();
    expect(view.getByText("On Writer")).toBeTruthy();
    expect(view.getByText("Not on any Bot")).toBeTruthy();
  });

  test("Add skills puts the ones ticked on this Bot", async () => {
    const sent = serving();
    const view = withData(<SkillsSections agent={ASSISTANT} />, {
      skills,
      held: ["standup", "review"],
    });
    fireEvent.click(await view.findByRole("button", { name: "Add skills" }));
    const dialog = await view.findByRole("dialog");
    expect(dialog.textContent).toContain("Draft");
    expect(dialog.textContent).not.toContain("Standup");
    fireEvent.click(view.getByRole("checkbox", { name: "Draft" }));
    fireEvent.click(view.getByRole("button", { name: "Add 1 skill" }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toStartWith(`PUT ${botGrantsPath(ASSISTANT.id)}/skill`);
    expect(sent[0]).toContain("draft");
  });

  test("a skill on other Bots too can be made this Bot's alone", async () => {
    const sent = serving();
    const view = withData(<SkillsSections agent={ASSISTANT} />, {
      skills,
      held: ["standup", "review"],
    });
    fireEvent.click(
      await view.findByRole("button", { name: "More for Review" }),
    );
    fireEvent.click(await view.findByText("Only on Assistant"));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toContain("/skills/review/bots");
    expect(sent[0]).toContain('"botIds":["assistant"]');
  });

  test("a Bot OpenBot made for the person has them too", async () => {
    serving();
    const view = withData(
      <SkillsSections agent={{ ...ASSISTANT, mine: false, canManage: true }} />,
      { skills, held: ["standup", "review"] },
    );
    expect(await view.findByRole("switch", { name: "Review" })).toBeTruthy();
    expect(view.getByRole("button", { name: "Add skills" })).toBeTruthy();
  });

  test("the team edition says nothing about other Bots and has no such menu", async () => {
    serving();
    const view = withData(<SkillsSections agent={ASSISTANT} />, {
      skills,
      held: ["standup", "review"],
      personal: false,
    });
    expect(await view.findByRole("switch", { name: "Review" })).toBeTruthy();
    expect(view.queryByText("Every Bot")).toBeNull();
    expect(view.queryByRole("button", { name: "More for Review" })).toBeNull();
  });
});
