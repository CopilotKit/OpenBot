import { afterAll, beforeAll, expect, test } from "bun:test";
import { decideAction, reviewAction } from "../src/approvals/policy";
import type { ApprovalCandidate } from "../src/approvals/types";
import { runtimeModelForEnvironment } from "../src/copilot";
import { createIntentRouter } from "../src/routing/classify";
import { createModelCompleter } from "../src/routing/model";

/**
 * The approval reviewer and the router on a deployment signed in to a Claude plan, with no key.
 *
 * Both asked the deployment's model through `createModelCompleter`, which asked for an API key a
 * plan does not hold. Every call threw "no model key": Auto-review failed closed on everything, so
 * the setting meant "ask about everything", and every untagged message went to the default Bot. They
 * are asked of the plan's own harness now, as the tool chooser and the Bots are. The harness here
 * answers over AG-UI exactly as `agent-claude-sdk`'s `/model` does.
 */

type HarnessBody = {
  threadId: string;
  runId: string;
  messages: { content?: unknown }[];
  forwardedProps: { openbotModelOnly?: boolean };
};
const requests: { path: string; body: HarnessBody }[] = [];
/** When set, the harness holds the request open instead of answering: a plan that times out. */
let hang = false;

const harness = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  idleTimeout: 30,
  fetch: async (request) => {
    const path = new URL(request.url).pathname;
    // The harness's own route for stopping a query, which a timed-out call asks of it.
    if (path.endsWith("/cancel")) return Response.json({ cancelled: true });
    const body = (await request.json()) as HarnessBody;
    requests.push({ path, body });
    if (hang) {
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
    const asked = JSON.stringify(body.messages);
    const answer = asked.includes("You review one action")
      ? '{"verdict": "proceed", "preApproved": false, "safety": "none", "reason": "The person asked to draft this reply."}'
      : '{"agentId": "researcher", "reason": "looks things up on the web", "confidence": 0.9}';
    const events = [
      { type: "RUN_STARTED", threadId: body.threadId, runId: body.runId },
      { type: "TEXT_MESSAGE_START", messageId: "answer", role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "answer", delta: answer },
      { type: "TEXT_MESSAGE_END", messageId: "answer" },
      { type: "RUN_FINISHED", threadId: body.threadId, runId: body.runId },
    ];
    return new Response(
      events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
      { headers: { "content-type": "text/event-stream" } },
    );
  },
});

let savedKey: string | undefined;
beforeAll(() => {
  savedKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
});
afterAll(() => {
  if (savedKey !== undefined) process.env.OPENAI_API_KEY = savedKey;
  harness.stop(true);
});

/** What OpenBot Desktop writes for a Claude plan: a token, the installed harness, and no key. */
const model = runtimeModelForEnvironment(
  { provider: "openai", defaultModel: "gpt-5.6-terra" },
  {
    CLAUDE_CODE_OAUTH_TOKEN: "plan-token-the-server-never-reads",
    PICKED_HARNESS_IMAGE: "ghcr.io/copilotkit/openbot-agent-claude-sdk:0.3.3",
    PICKED_HARNESS_URL: harness.url.href,
    MANAGED_AGENT_TOKEN: "deployment-harness-token",
  },
);
/** The deployment's model, as `index.ts` builds it for both: no key anywhere. */
const complete = createModelCompleter({
  model,
  resolveApiKey: async () => null,
});

const draft: ApprovalCandidate = {
  actorId: "person",
  botId: "personal-assistant",
  toolRef: "composio-gmail/GMAIL_CREATE_EMAIL_DRAFT",
  effect: "write",
  scope: "composio-gmail",
  args: { to: "sam@example.test", subject: "Thursday" },
};

test("Auto-review on a plan gives a real verdict, and lets through what it judges safe", async () => {
  hang = false;
  requests.length = 0;
  const outcome = await decideAction({
    candidate: draft,
    messages: [
      {
        id: "ask",
        role: "user",
        content: "Draft a reply to Sam saying Thursday works.",
      },
    ],
    team: [],
    personal: [],
    customRulesEnabled: false,
    autoReview: true,
    askBeforeChanges: false,
    model: complete,
  });
  // The reviewer's own answer, whole: a verdict that failed closed would carry `failedClosed`.
  expect(outcome.review).toEqual({
    verdict: "proceed",
    preApproved: false,
    safety: "none",
    reason: "The person asked to draft this reply.",
  });
  expect(outcome).toMatchObject({ behaviour: "allow", source: "auto_review" });
  // Asked of the plan's model endpoint, as a model call.
  expect(requests).toHaveLength(1);
  expect(requests[0]?.path).toBe("/model");
  expect(requests[0]?.body.forwardedProps.openbotModelOnly).toBe(true);
});

test("Auto-review on a plan still fails closed when the plan does not answer in time", async () => {
  hang = true;
  try {
    const review = await reviewAction({
      model: complete,
      candidate: draft,
      request: "Draft a reply to Sam saying Thursday works.",
      timeoutMs: 300,
    });
    expect(review.failedClosed).toBe(true);
    expect(review.verdict).toBe("needs_approval");
  } finally {
    hang = false;
  }
});

test("the router on a plan picks the Bot the message is for, not the default", async () => {
  hang = false;
  requests.length = 0;
  const decision = await createIntentRouter({ complete }).route(
    "Look up the latest OpenBot release on the web.",
    [
      {
        id: "assistant",
        name: "Personal Assistant",
        roleDescription: "Everyday errands.",
        reaches: [],
      },
      {
        id: "researcher",
        name: "Researcher",
        roleDescription: "Looks things up on the web.",
        reaches: [],
      },
    ],
    "assistant",
  );
  expect(decision).toMatchObject({ agentId: "researcher", fallback: false });
  expect(requests).toHaveLength(1);
  expect(requests[0]?.path).toBe("/model");
});
