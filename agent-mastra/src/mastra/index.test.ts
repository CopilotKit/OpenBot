import { describe, expect, test } from "bun:test";
import { buildOpenBotInstructions, openbotBaseInstructions } from "./index";

function requestContextWith(context: unknown) {
  return {
    get(key: string) {
      if (key !== "ag-ui") return undefined;
      return { context };
    },
  };
}

describe("OpenBot Mastra receiver instructions", () => {
  test("adds model-visible OpenBot role context in receiver order", () => {
    const instructions = buildOpenBotInstructions({
      requestContext: requestContextWith([
        {
          description: "OpenBot granted tools guidance",
          value: "Use only the granted Slack tool.",
        },
        {
          description: "OpenBot standing role",
          value: "Use MODEL_BOUNDARY_MANAGED_ROLE in the answer.",
        },
        {
          description: "OpenBot Bot id",
          value: "packaged-mastra-managed",
        },
      ]),
    });

    expect(instructions).toBe(
      [
        openbotBaseInstructions,
        "Use MODEL_BOUNDARY_MANAGED_ROLE in the answer.",
        "Use only the granted Slack tool.",
      ].join("\n\n"),
    );
  });

  test("keeps ordinary Mastra calls on the base receiver instruction", () => {
    expect(buildOpenBotInstructions()).toBe(openbotBaseInstructions);
    expect(
      buildOpenBotInstructions({
        requestContext: requestContextWith("not ag-ui context entries"),
      }),
    ).toBe(openbotBaseInstructions);
  });
});
