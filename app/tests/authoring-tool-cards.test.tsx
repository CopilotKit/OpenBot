import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { CopilotKitProvider, useCopilotKit } from "@copilotkit/react-core/v2";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { ComponentType, ReactNode } from "react";
import { BOT_CREATOR_SLUG } from "@/lib/agents/proposal";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { ActiveBotProvider, useActiveBot } from "@/lib/copilot/active-bot";
import { BotTools } from "@/lib/copilot/bot-tools";
import { SkillTools } from "@/lib/copilot/skill-tools";
import { pluginsPageQueryOptions } from "@/lib/plugins/queries";
import { SKILL_CREATOR_SLUG } from "@/lib/skills/proposal";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/**
 * The cards and answers of the two authoring tools, drawn by what the SDK actually keeps.
 *
 * The SDK registers a tool once, when its name or `available` changes, and never again when its
 * renderer or handler does. Both hooks turn on when the Bot's grant arrives, which is the same render
 * that first asks for the roster and the skills, so anything the kept renderer or handler read from
 * that render was the empty list from before those queries came back. The card for a coworker named
 * like one that already exists said "Create", not "Create ..., again"; the card for a skill that
 * would overwrite an existing one said "Create", not "Replace"; and `list_skills` told the Bot no
 * skills existed. This uses the real provider and the real hooks, so an SDK that changes how it
 * keeps tools is caught here too.
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
  queryClient.clear();
});

const BOT = "bot-a";
const ME = "user-1";

const existingBot = {
  id: "agent-1",
  name: "Researcher",
  title: "Research",
  roleDescription: "Looks things up.",
  avatarSeed: "researcher",
  visibility: "private",
  endpoint: null,
  builtIn: true,
  hasAuth: false,
  hasCallbackToken: false,
  hidden: false,
  pinned: false,
  assigned: false,
  systemOwned: false,
  mine: true,
};

const existingSkill = {
  id: "skill-1",
  slug: "weekly-summary",
  ownerUserId: ME,
  title: "Weekly summary",
  summary: "Say what moved this week.",
  instructions: "List what moved this week.",
  origin: "user",
  installedBy: ME,
  grantedTo: [],
  tools: [],
};

/**
 * The server, with the roster and the skills held back until `release` is called, so they arrive
 * after the grant has turned the tools on: the order a first visit sees.
 */
function serving(grant: string) {
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  global.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const path = new URL(String(input), "http://127.0.0.1").pathname;
      if (path === `/api/plugins/for/${BOT}`)
        return Response.json({
          tools: [],
          skills: [
            { slug: grant, title: grant, summary: "", instructions: "" },
          ],
        });
      if (path === "/api/me")
        return Response.json({
          user: { id: ME, email: "me@example.com", role: "user" },
        });
      if (path === "/api/agents") {
        await released;
        return Response.json({ agents: [existingBot] });
      }
      if (path === "/api/plugins") {
        await released;
        return Response.json({
          catalogue: [],
          servers: [],
          skills: [existingSkill],
          botsMayCallBack: false,
        });
      }
      return Response.json({ error: "Not found" }, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
  return () => release();
}

type Renderer = ComponentType<Record<string, unknown>>;
type Handler = (args: unknown, context: unknown) => Promise<unknown>;
type Kept = {
  renderers: Map<string, Renderer>;
  handlers: Map<string, Handler>;
};

function Capture({ kept, names }: { kept: Kept; names: string[] }) {
  const { copilotkit } = useCopilotKit();
  for (const name of names) {
    const entry = copilotkit.renderToolCalls.find(
      (candidate) => candidate.name === name,
    );
    if (entry) kept.renderers.set(name, entry.render as Renderer);
    const tool = copilotkit.getTool({ toolName: name });
    if (tool?.handler) kept.handlers.set(name, tool.handler as Handler);
  }
  return null;
}

function Declare() {
  useActiveBot(BOT);
  return null;
}

function Providers({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <CopilotKitProvider>
        <ActiveBotProvider>
          <Declare />
          {children}
        </ActiveBotProvider>
      </CopilotKitProvider>
    </QueryClientProvider>
  );
}

test("a proposed coworker named like an existing one says so", async () => {
  const release = serving(BOT_CREATOR_SLUG);
  const kept: Kept = { renderers: new Map(), handlers: new Map() };
  const tree = render(
    <Providers>
      <BotTools />
      <Capture kept={kept} names={["save_bot"]} />
    </Providers>,
  );
  await waitFor(() => expect(kept.renderers.get("save_bot")).toBeDefined());

  // The roster arrives after the grant turned the tool on.
  release();
  const Kept = kept.renderers.get("save_bot") as Renderer;
  tree.rerender(
    <Providers>
      <BotTools />
      <Capture kept={kept} names={["save_bot"]} />
      <Kept
        name="save_bot"
        args={{ name: "Researcher" }}
        status="inProgress"
        toolCallId="call-save-bot"
      />
    </Providers>,
  );

  await tree.findByText("Writing the coworker…");
  // Whoever asks for it, the roster has loaded by now.
  await waitFor(() =>
    expect(
      queryClient.getQueryData(agentListQueryOptions().queryKey),
    ).toHaveLength(1),
  );
  await tree.findByText("Create Researcher, again");
});

async function skillToolsLoaded() {
  const release = serving(SKILL_CREATOR_SLUG);
  const kept: Kept = { renderers: new Map(), handlers: new Map() };
  const names = ["save_skill", "list_skills", "read_skill"];
  const drawn = (card?: ReactNode) => (
    <Providers>
      <SkillTools />
      <Capture kept={kept} names={names} />
      {card}
    </Providers>
  );
  const tree = render(drawn());
  await waitFor(() => {
    expect(kept.renderers.get("save_skill")).toBeDefined();
    expect(kept.handlers.get("list_skills")).toBeDefined();
  });

  // The skills arrive after the grant turned the tools on.
  release();
  return { kept, tree, drawn };
}

test("a proposed skill that would overwrite an existing one says so", async () => {
  const { kept, tree, drawn } = await skillToolsLoaded();
  const Kept = kept.renderers.get("save_skill") as Renderer;
  tree.rerender(
    drawn(
      <Kept
        name="save_skill"
        args={{ slug: "weekly-summary" }}
        status="inProgress"
        toolCallId="call-save-skill"
      />,
    ),
  );

  await tree.findByText("Writing the skill…");
  // Whoever asks for them, the skills have loaded by now.
  await waitFor(() =>
    expect(
      queryClient.getQueryData(pluginsPageQueryOptions().queryKey)?.skills,
    ).toHaveLength(1),
  );
  await tree.findByText("Replace /weekly-summary");
});

test("the skill reads tell the Bot about skills that loaded after the tools turned on", async () => {
  const { kept } = await skillToolsLoaded();
  // What the model is told, from the handlers the SDK kept.
  const listed = await kept.handlers.get("list_skills")?.({}, {});
  expect(String(listed)).toContain("/weekly-summary — Weekly summary (yours)");
  const read = await kept.handlers.get("read_skill")?.(
    { slug: "weekly-summary" },
    {},
  );
  expect(String(read)).toContain("List what moved this week.");
});
