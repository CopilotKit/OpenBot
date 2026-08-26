import { describe, expect, test } from "bun:test";
import type { AbstractAgent, BaseEvent, Message } from "@ag-ui/client";
import { Observable } from "rxjs";
import { createHandoffDelivery } from "../src/agents/handoff-delivery";
import type { HandoffWork } from "../src/agents/handoff-runner";

/**
 * Turning a hop into a turn.
 *
 * The property that matters is that the addressed Bot joins a conversation rather than answering a
 * question in the dark, and that a run which ended in an error is not mistaken for one that answered.
 */

const WORK: HandoffWork = {
  fromBotId: "assistant",
  toBotId: "researcher",
  actorId: "user-1",
  threadId: "thread-1",
  runId: "run-1",
  depth: 1,
  task: "find the outage window",
};

const PRIOR: Message[] = [
  { id: "m1", role: "user", content: "we had an outage yesterday" },
  { id: "m2", role: "assistant", content: "I will find out when" },
];

function delivery(
  events: BaseEvent[],
  agent: AbstractAgent | null = {} as AbstractAgent,
) {
  const requests: Array<{ threadId: string; input: Record<string, unknown> }> =
    [];
  return {
    requests,
    delivery: createHandoffDelivery({
      agentFor: async () => agent,
      history: async () => PRIOR,
      newRunId: () => "run-2",
      runner: {
        run: (request) => {
          requests.push({
            threadId: request.threadId,
            input: request.input as Record<string, unknown>,
          });
          return new Observable<BaseEvent>((subscriber) => {
            for (const event of events) subscriber.next(event);
            subscriber.complete();
          });
        },
      },
    }),
  };
}

const FINISHED = [{ type: "RUN_FINISHED" }] as unknown as BaseEvent[];

describe("turning a hop into a turn", () => {
  test("the addressed Bot reads the conversation before the ask", async () => {
    const { delivery: deliver, requests } = delivery(FINISHED);

    await deliver.deliver({
      work: WORK,
      message: "assistant has asked you to help",
      assertion: "signed",
    });

    const messages = requests[0]?.input.messages as Message[];
    // The conversation, then the ask. A Bot handed only the task answers a question whose other half
    // was settled three messages ago.
    expect(messages.map((m) => m.id).slice(0, 2)).toEqual(["m1", "m2"]);
    expect(messages.at(-1)).toMatchObject({
      role: "user",
      content: "assistant has asked you to help",
    });
  });

  test("the run carries the deployment's signed statement of what it is", async () => {
    const { delivery: deliver, requests } = delivery(FINISHED);

    await deliver.deliver({
      work: WORK,
      message: "m",
      assertion: "signed-assertion",
    });

    expect(requests[0]?.input.forwardedProps).toEqual({
      openbotRun: "signed-assertion",
    });
    expect(requests[0]?.threadId).toBe("thread-1");
  });

  /*
   * A run that errored said nothing in the conversation. Treating it as delivered finishes the work
   * and leaves the person waiting for an answer that will never come.
   */
  test("a run that ended in an error is not a delivery", async () => {
    const { delivery: deliver } = delivery([
      { type: "RUN_ERROR", message: "the model refused" },
    ] as unknown as BaseEvent[]);

    await expect(
      deliver.deliver({ work: WORK, message: "m", assertion: "s" }),
    ).rejects.toThrow("the model refused");
  });

  test("a Bot that cannot be built is worth another go rather than a silent drop", async () => {
    const { delivery: deliver } = delivery(FINISHED, null);

    await expect(
      deliver.deliver({ work: WORK, message: "m", assertion: "s" }),
    ).rejects.toThrow("researcher");
  });
});
