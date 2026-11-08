import { afterAll, beforeAll, expect, test } from "bun:test";
import { runtimeModelForEnvironment } from "../src/copilot";
import { resolveModelApiKey } from "../src/credentials";
import {
  SELECTION_FLOOR,
  type SelectableSkill,
  selectTools,
} from "../src/plugins/selection";
import { createSkillChooser } from "../src/routing/model";

/**
 * Choosing a run's tools on every way OpenBot Desktop signs in: a Claude or ChatGPT plan with no key,
 * and the API key the person typed in setup.
 *
 * Seen on Windows (OpenBot Desktop, personal edition, Claude plan): every turn's Activity row read
 * "Choose tools for a run, 96 of 96 tools, Couldn't choose, so all were offered". The chooser asked
 * for the deployment's API key, a plan holds none, so it threw every time and the Bot was handed
 * every tool it held. It is asked of the plan's own harness now, as the Bots are answered. The
 * harness here answers over AG-UI exactly as `agent-claude-sdk`'s `/model` does.
 */

/** A run body as the harness receives it, as much of it as these read. */
type HarnessBody = {
  threadId: string;
  runId: string;
  tools: unknown[];
  messages: unknown[];
  forwardedProps: { openbotModelOnly?: boolean };
};
const requests: { path: string; token: string | null; body: HarnessBody }[] =
  [];
let answer = '{"skills": ["research-public-web"]}';

const harness = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: async (request) => {
    const body = (await request.json()) as HarnessBody;
    requests.push({
      path: new URL(request.url).pathname,
      token: request.headers.get("x-openbot-agent-token"),
      body,
    });
    const events = [
      { type: "RUN_STARTED", threadId: body.threadId, runId: body.runId },
      { type: "TEXT_MESSAGE_START", messageId: "choice", role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "choice", delta: answer },
      { type: "TEXT_MESSAGE_END", messageId: "choice" },
      { type: "RUN_FINISHED", threadId: body.threadId, runId: body.runId },
    ];
    return new Response(
      events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
      { headers: { "content-type": "text/event-stream" } },
    );
  },
});

/** OpenAI's Chat Completions, as the chooser calls it with a key. */
const keyRequests: {
  authorization: string | null;
  body: { model?: string };
}[] = [];
const openai = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: async (request) => {
    keyRequests.push({
      authorization: request.headers.get("authorization"),
      body: (await request.json()) as { model?: string },
    });
    return Response.json({
      choices: [{ message: { role: "assistant", content: answer } }],
    });
  },
});

let savedKey: string | undefined;
let savedBaseUrl: string | undefined;
beforeAll(() => {
  savedKey = process.env.OPENAI_API_KEY;
  savedBaseUrl = process.env.OPENAI_BASE_URL;
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_BASE_URL;
});
afterAll(() => {
  if (savedKey !== undefined) process.env.OPENAI_API_KEY = savedKey;
  if (savedBaseUrl !== undefined) process.env.OPENAI_BASE_URL = savedBaseUrl;
  else delete process.env.OPENAI_BASE_URL;
  harness.stop(true);
  openai.stop(true);
});

/** What OpenBot Desktop writes for a Claude plan: a token, the installed harness, and no key. */
const CLAUDE_PLAN = {
  CLAUDE_CODE_OAUTH_TOKEN: "plan-token-the-server-never-reads",
  PICKED_HARNESS_IMAGE: "ghcr.io/copilotkit/openbot-agent-claude-sdk:0.3.3",
  PICKED_HARNESS_URL: harness.url.href,
  MANAGED_AGENT_TOKEN: "deployment-harness-token",
};

const ROUTINES = [
  "create_routine",
  "list_routines",
  "update_routine",
  "delete_routine",
  "create_trigger",
  "list_triggers",
  "pause_trigger",
  "resume_trigger",
  "delete_trigger",
  "create_goal",
  "list_goals",
  "update_goal",
  "run_goal",
  "pause_goal",
  "resume_goal",
  "complete_goal",
].map((name) => ({ ref: `routines/${name}` }));
const PARALLEL = ["web_search", "web_fetch", "send_feedback"].map((name) => ({
  ref: `parallel/${name}`,
}));
const DRIVE = ["search_files", "read_file_content", "get_file_metadata"].map(
  (name) => ({ ref: `google-drive/${name}` }),
);
const TOOLS = [...ROUTINES, ...PARALLEL, ...DRIVE];

/** The personal package's skills, as `examples/personal/skills.yaml` declares them. */
const SKILLS: SelectableSkill[] = [
  {
    slug: "research-public-web",
    title: "Research the public web",
    summary: "Search the public web and read pages.",
    tools: ["@research/search", "@research/fetch"],
  },
  {
    slug: "find-a-document",
    title: "Find a document",
    summary:
      "Search the connected document sources for a file and read what it says.",
    tools: [
      "google-drive/search_files",
      "google-drive/read_file_content",
      "google-drive/get_file_metadata",
    ],
  },
];

test("a Claude plan with no key chooses a run's tools on the plan's harness", async () => {
  expect(TOOLS.length).toBeGreaterThan(SELECTION_FLOOR);
  requests.length = 0;
  answer = '{"skills": ["research-public-web"]}';
  const model = runtimeModelForEnvironment(
    { provider: "openai", defaultModel: "gpt-5.6-terra" },
    CLAUDE_PLAN,
  );
  const chosen = await selectTools({
    tools: TOOLS,
    skills: SKILLS,
    text: "What changed in the latest OpenBot release? Look it up on the web.",
    choose: createSkillChooser(model, async () => null),
  });

  expect(chosen.reason).toBe("selected");
  expect(chosen.skills).toEqual(["research-public-web"]);
  const offered = chosen.offered.map((tool) => tool.ref);
  // The research tools it asked for, and nothing another skill claims.
  expect(offered).toContain("parallel/web_search");
  expect(offered).toContain("parallel/web_fetch");
  expect(offered).not.toContain("google-drive/search_files");
  expect(offered.length).toBeLessThan(TOOLS.length);

  // Asked once, of the plan's model endpoint, as a model call with no tools of its own.
  expect(requests).toHaveLength(1);
  expect(requests[0]?.path).toBe("/model");
  expect(requests[0]?.token).toBe("deployment-harness-token");
  expect(requests[0]?.body.tools).toEqual([]);
  expect(requests[0]?.body.forwardedProps.openbotModelOnly).toBe(true);
  expect(JSON.stringify(requests[0]?.body.messages)).toContain(
    "You choose which capabilities to load",
  );
});

test("a ChatGPT plan with no key chooses too", async () => {
  requests.length = 0;
  answer = '{"skills": ["find-a-document"]}';
  const model = runtimeModelForEnvironment(
    { provider: "openai", defaultModel: "gpt-5.6-terra" },
    {
      CHATGPT_AUTH_FILE: "/root/.langchain/chatgpt.json",
      PICKED_HARNESS_IMAGE:
        "ghcr.io/copilotkit/openbot-agent-langgraph-agui:0.3.3",
      PICKED_HARNESS_URL: harness.url.href,
      MANAGED_AGENT_TOKEN: "deployment-harness-token",
    },
  );
  const chosen = await selectTools({
    tools: TOOLS,
    skills: SKILLS,
    text: "Find the budget spreadsheet in my Drive.",
    choose: createSkillChooser(model, async () => null),
  });
  expect(chosen.reason).toBe("selected");
  expect(chosen.offered.map((tool) => tool.ref)).toContain(
    "google-drive/search_files",
  );
  expect(chosen.offered.map((tool) => tool.ref)).not.toContain(
    "parallel/web_search",
  );
  expect(requests).toHaveLength(1);
});

test("the OpenAI key typed in setup chooses, read from where the desktop puts it", async () => {
  /*
   * OpenBot Desktop writes the key the person typed in setup as OPENAI_API_KEY, for the server and
   * the harness alike, and nothing is saved in Keys. The chooser asks OpenAI with it.
   */
  const desktop = {
    OPENAI_API_KEY: "sk-typed-in-setup",
    PICKED_HARNESS_IMAGE:
      "ghcr.io/copilotkit/openbot-agent-langgraph-agui:0.3.3",
    PICKED_HARNESS_URL: harness.url.href,
    MANAGED_AGENT_TOKEN: "deployment-harness-token",
    BOT_PROVIDER: "",
  };
  process.env.OPENAI_BASE_URL = `${openai.url.href.replace(/\/$/, "")}/v1`;
  keyRequests.length = 0;
  requests.length = 0;
  answer = '{"skills": ["research-public-web"]}';
  try {
    const model = runtimeModelForEnvironment(
      { provider: "openai", defaultModel: "gpt-5.6-terra" },
      desktop,
    );
    expect(model.plan).toBeUndefined();
    const chosen = await selectTools({
      tools: TOOLS,
      skills: SKILLS,
      text: "What changed in the latest OpenBot release? Look it up on the web.",
      choose: createSkillChooser(model, () =>
        resolveModelApiKey({
          encryptionKey: "unused",
          reader: { readModelSecret: async () => null },
          provider: model.provider,
          keyId: "openai-api-key",
          environment: desktop,
        }),
      ),
    });
    expect(chosen.reason).toBe("selected");
    expect(chosen.offered.length).toBeLessThan(TOOLS.length);
    expect(keyRequests).toHaveLength(1);
    expect(keyRequests[0]?.authorization).toBe("Bearer sk-typed-in-setup");
    expect(keyRequests[0]?.body.model).toBe("gpt-5.6-terra");
    // Not the harness: a key is asked of the provider directly.
    expect(requests).toHaveLength(0);
  } finally {
    delete process.env.OPENAI_BASE_URL;
  }
});
