import { expect, test } from "bun:test";
import {
  AbstractAgent,
  type BaseEvent,
  EventType,
  type RunAgentInput,
} from "@ag-ui/client";
import { CloningRemoteAgent } from "@openbot/toolkit/copilotkit/agents";
import { of } from "rxjs";
import { PersonalMemoryMiddleware } from "../src/memory/tools";

/**
 * A Bot reached over AG-UI, the way every Bot a person makes is reached when the deployment runs a managed agent: it
 * records what each run hands it. The runtime never runs the agent it was given; it clones it per run, so the clone is
 * what this records.
 */
class RecordingRemote extends AbstractAgent {
  constructor(readonly requests: RunAgentInput[] = []) {
    super({ agentId: "remote-bot" });
  }
  run(input: RunAgentInput) {
    this.requests.push(input);
    const started: BaseEvent = {
      type: EventType.RUN_STARTED,
      runId: input.runId,
      threadId: input.threadId,
    } as BaseEvent;
    const finished: BaseEvent = {
      type: EventType.RUN_FINISHED,
      runId: input.runId,
      threadId: input.threadId,
    } as BaseEvent;
    return of(started, finished);
  }
  override clone() {
    return new RecordingRemote(this.requests);
  }
}

/*
 * FOUND IN THE BROWSER, on the two-organization end to end: a person told their Bot to remember a fact, it was saved
 * and listed, and a later conversation answered "I don't have any record of that". The Bot was remote (a Bot a person
 * creates runs on the managed agent), and the runtime clones the agent for each run. The clone re-attached OpenBot's
 * own middleware and dropped every one added after it, so the person's memory (and their name) never reached the model.
 */
test("a remote Bot's run on the runtime's per-run clone still carries the person's memory", async () => {
  const remote = new RecordingRemote();
  const attached: string[] = [];
  const agent = new CloningRemoteAgent(remote, () => {
    attached.push("openbot");
  });
  agent.use(
    new PersonalMemoryMiddleware(
      "remote-bot",
      async () =>
        'Personal memory for this person. [{"content":"My favourite colour is teal."}]',
    ),
  );

  const clone = agent.clone();
  clone.threadId = "thread";
  await clone.runAgent({ runId: "run" });

  expect(remote.requests).toHaveLength(1);
  const sent = remote.requests[0];
  expect(sent?.messages[0]).toMatchObject({
    id: "openbot:personal-memory",
    role: "system",
  });
  expect(
    sent?.context.some(
      (entry) =>
        entry.description === "OpenBot personal memory" &&
        entry.value.includes("teal"),
    ),
  ).toBe(true);
  // OpenBot's own middleware is attached afresh on each instance, never carried over as well.
  expect(attached).toEqual(["openbot", "openbot"]);
});
