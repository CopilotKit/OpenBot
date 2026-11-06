import { describe, expect, test } from "bun:test";
import type { RunAgentInput } from "@ag-ui/client";
import { effortProviderOptions, modelForRun, planChoice } from "../src/copilot";

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
  test("the deployment's, when the person picked nothing and nothing was listed", async () => {
    expect(await modelForRun(deployment, run(), async () => undefined)).toBe(
      deployment,
    );
  });

  test("the person's pick for the conversation the run answers in, with its effort", async () => {
    const asked: string[] = [];
    const result = await modelForRun(deployment, run(), async (input) => {
      asked.push(input.threadId);
      return { model: "gpt-6.1-sol", effort: "high", listed: true };
    });
    expect(result).toEqual({
      provider: "openai",
      defaultModel: "gpt-6.1-sol",
      effort: "high",
      listed: true,
    });
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

  test("a plan is sent the model its own listing offers", async () => {
    const plan = { ...deployment, plan: { provider: "chatgpt" } as never };
    const result = await modelForRun(plan, run(), async () => ({
      model: "gpt-6.1-terra",
      effort: "low",
      listed: true,
    }));
    expect(planChoice(result)).toEqual({
      model: "gpt-6.1-terra",
      reasoningEffort: "low",
    });
  });

  test("a plan whose listing could not be read is sent no model, never the configured one", async () => {
    // gpt-5.5 is what a ChatGPT plan refused: "not supported when using Codex with a ChatGPT account".
    const plan = { ...deployment, plan: { provider: "chatgpt" } as never };
    const result = await modelForRun(plan, run(), async () => ({
      model: "gpt-5.5",
      listed: false,
    }));
    expect(result).toBe(plan);
    expect(planChoice(result)).toBeUndefined();
  });
});

describe("how an effort reaches the model", () => {
  test("OpenAI and every OpenAI-compatible endpoint take the AI SDK's reasoningEffort", () => {
    expect(effortProviderOptions({ ...deployment, effort: "xhigh" })).toEqual({
      openai: { reasoningEffort: "xhigh" },
    });
  });

  test("Anthropic takes its own effort", () => {
    expect(
      effortProviderOptions({
        provider: "anthropic",
        defaultModel: "claude-sonnet-5-5",
        effort: "max",
      }),
    ).toEqual({ anthropic: { effort: "max" } });
  });

  test("no effort, nothing sent", () => {
    expect(effortProviderOptions(deployment)).toBeUndefined();
  });
});
