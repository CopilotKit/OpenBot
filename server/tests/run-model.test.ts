import { describe, expect, test } from "bun:test";
import type { RunAgentInput } from "@ag-ui/client";
import { modelForRun } from "../src/copilot";

const deployment = { provider: "openai" as const, defaultModel: "gpt-5.5" };

const run = (forwardedProps: unknown = {}) =>
  ({
    threadId: "thread-1",
    runId: "r",
    messages: [],
    tools: [],
    context: [],
    state: {},
    forwardedProps,
  }) as RunAgentInput;

describe("the model one run of a built-in Bot uses", () => {
  test("the deployment's, when the person picked nothing", async () => {
    expect(await modelForRun(deployment, run(), async () => undefined)).toBe(
      deployment,
    );
  });

  test("the person's pick for the conversation the run answers in", async () => {
    const asked: string[] = [];
    const result = await modelForRun(deployment, run(), async (input) => {
      asked.push(input.threadId);
      return "gpt-4o";
    });
    expect(result).toEqual({ provider: "openai", defaultModel: "gpt-4o" });
    expect(asked).toEqual(["thread-1"]);
  });

  test("never what the request names: the browser does not choose the model", async () => {
    expect(
      await modelForRun(
        deployment,
        run({ openbotModel: "gpt-4o", model: "anthropic/claude-opus-5-5" }),
        async () => undefined,
      ),
    ).toBe(deployment);
  });

  test("a deployment with no record of picks uses its own model", async () => {
    expect(await modelForRun(deployment, run(), undefined)).toBe(deployment);
  });

  test("a plan picks its own model, so the pick is not even read", async () => {
    const plan = { ...deployment, plan: { kind: "claude" } as never };
    let read = 0;
    expect(
      await modelForRun(plan, run(), async () => {
        read += 1;
        return "gpt-4o";
      }),
    ).toBe(plan);
    expect(read).toBe(0);
  });
});
