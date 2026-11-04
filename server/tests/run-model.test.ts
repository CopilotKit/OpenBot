import { describe, expect, test } from "bun:test";
import type { RunAgentInput } from "@ag-ui/client";
import { ModelNotOfferedError, modelForRun } from "../src/copilot";
import { requestedModel } from "../src/model-catalogue";

const deployment = { provider: "openai" as const, defaultModel: "gpt-5.5" };

const run = (forwardedProps: unknown) =>
  ({
    threadId: "t",
    runId: "r",
    messages: [],
    tools: [],
    context: [],
    state: {},
    forwardedProps,
  }) as RunAgentInput;

const offering =
  (...ids: string[]) =>
  async (id: string) =>
    ids.includes(id);

describe("the model a run asks for", () => {
  test("is read from openbotModel, trimmed", () => {
    expect(requestedModel({ openbotModel: " gpt-4o " })).toBe("gpt-4o");
  });

  test("is nothing when absent, blank or not a string", () => {
    expect(requestedModel(undefined)).toBeUndefined();
    expect(requestedModel({})).toBeUndefined();
    expect(requestedModel({ openbotModel: "  " })).toBeUndefined();
    expect(requestedModel({ openbotModel: 4 })).toBeUndefined();
    // The runtime's own override property is not ours and is never read.
    expect(
      requestedModel({ model: "anthropic/claude-opus-5-5" }),
    ).toBeUndefined();
  });
});

describe("the model one run of a built-in Bot uses", () => {
  test("the deployment's, when nothing was asked for", async () => {
    expect(await modelForRun(deployment, run({}), offering("gpt-4o"))).toBe(
      deployment,
    );
  });

  test("the one asked for, when the deployment offers it", async () => {
    expect(
      await modelForRun(
        deployment,
        run({ openbotModel: "gpt-4o" }),
        offering("gpt-4o"),
      ),
    ).toEqual({ provider: "openai", defaultModel: "gpt-4o" });
  });

  test("refuses one the deployment does not offer, rather than quietly using another", async () => {
    await expect(
      modelForRun(
        deployment,
        run({ openbotModel: "gpt-image-2" }),
        offering("gpt-4o"),
      ),
    ).rejects.toBeInstanceOf(ModelNotOfferedError);
  });

  test("asking for the deployment's own model asks nobody", async () => {
    let asked = 0;
    const result = await modelForRun(
      deployment,
      run({ openbotModel: "gpt-5.5" }),
      async () => {
        asked += 1;
        return true;
      },
    );
    expect(result).toBe(deployment);
    expect(asked).toBe(0);
  });

  test("a deployment with no catalogue ignores the request", async () => {
    expect(
      await modelForRun(deployment, run({ openbotModel: "gpt-4o" }), undefined),
    ).toBe(deployment);
  });

  test("a plan picks its own model, so the request is ignored", async () => {
    const plan = { ...deployment, plan: { kind: "claude" } as never };
    expect(
      await modelForRun(
        plan,
        run({ openbotModel: "gpt-4o" }),
        offering("gpt-4o"),
      ),
    ).toBe(plan);
  });
});
