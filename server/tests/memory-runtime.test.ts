import { expect, test } from "bun:test";
import {
  AbstractAgent,
  type BaseEvent,
  EventType,
  type RunAgentInput,
} from "@ag-ui/client";
import { lastValueFrom, of, toArray } from "rxjs";
import {
  mintRunAssertion,
  readRunAssertion,
} from "../src/agents/callback-token";
import { PersonalMemoryMiddleware } from "../src/memory/tools";

class SelectedAgent extends AbstractAgent {
  readonly requests: RunAgentInput[] = [];
  run(input: RunAgentInput) {
    this.requests.push(input);
    return of<BaseEvent>(
      {
        type: EventType.RUN_STARTED,
        runId: input.runId,
        threadId: input.threadId,
      },
      {
        type: EventType.RUN_FINISHED,
        runId: input.runId,
        threadId: input.threadId,
      },
    );
  }
}
const input = (): RunAgentInput => ({
  runId: "run",
  threadId: "thread",
  messages: [{ id: "user", role: "user", content: "What should I know?" }],
  context: [],
  tools: [],
  state: { progress: 1 },
  forwardedProps: { openbotRun: "signed" },
});
test("background ingestion retains its memory initiator in signed assertions", () => {
  const signed = mintRunAssertion(
    {
      botId: "selected",
      actorId: "owner",
      runId: "run",
      initiator: { kind: "memory", id: "source" },
    },
    "memory-test-key",
  );
  expect(readRunAssertion(signed, "memory-test-key")?.initiator).toEqual({
    kind: "memory",
    id: "source",
  });
});
async function run(load: (bot: string) => Promise<string>, request = input()) {
  const agent = new SelectedAgent({ agentId: "selected" });
  await lastValueFrom(
    new PersonalMemoryMiddleware("selected", load)
      .run(request, agent)
      .pipe(toArray()),
  );
  return agent.requests[0];
}
test("selected AGUI receives attributed personal memory", async () => {
  let selected = "";
  const request = await run(async (id) => {
    selected = id;
    return "Morning preference from You";
  });
  expect(selected).toBe("selected");
  expect(request?.messages[0]?.content).toContain("Morning preference");
});
test("later AGUI runs reflect edited memory without rebuilding the middleware", async () => {
  let fact = "old";
  const middleware = new PersonalMemoryMiddleware("selected", async () => fact);
  const agent = new SelectedAgent({ agentId: "selected" });
  await lastValueFrom(middleware.run(input(), agent).pipe(toArray()));
  fact = "updated";
  await lastValueFrom(middleware.run(input(), agent).pipe(toArray()));
  expect(agent.requests[0]?.messages[0]?.content).toBe("old");
  expect(agent.requests[1]?.messages[0]?.content).toBe("updated");
});
test("disabled or deleted memory removes stale replayed context", async () => {
  const request = input();
  request.messages.unshift({
    id: "openbot:personal-memory",
    role: "system",
    content: "deleted fact",
  });
  request.context.push({
    description: "OpenBot personal memory",
    value: "deleted fact",
  });
  const next = await run(async () => "", request);
  expect(next?.messages).toHaveLength(1);
  expect(next?.context).toHaveLength(0);
});
test("personal memory retains Automatic Learning catalog and tool authority", async () => {
  const request = input();
  request.messages.unshift({
    id: "openbot:learned-skills",
    role: "system",
    content: "approved catalog",
  });
  request.tools.push({
    name: "copilotkit_load_skill",
    description: "Learned skill",
    parameters: {},
  });
  const next = await run(async () => "fact", request);
  expect(
    next?.messages.some((message) => message.id === "openbot:learned-skills"),
  ).toBe(true);
  expect(next?.tools).toEqual(request.tools);
  expect(next?.forwardedProps).toEqual(request.forwardedProps);
});
test("personal memory retains canonical user messages and continuation state", async () => {
  const request = input();
  const next = await run(async () => "fact", request);
  expect(next?.messages.at(-1)).toEqual(request.messages[0]);
  expect(next?.state).toEqual(request.state);
  expect(next?.threadId).toBe(request.threadId);
});
test("memory database failures stop the AGUI run visibly", async () => {
  await expect(
    run(async () => {
      throw new Error("memory read failed");
    }),
  ).rejects.toThrow("memory read failed");
});
