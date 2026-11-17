import { expect, test } from "bun:test";
import {
  PERSONAL_ASSISTANT_UI_GUIDANCE,
  withPersonalAssistantUiGuidance,
} from "@/lib/copilot/a2ui-guidance";
import { GENERATIVE_UI_DESIGN_SKILL } from "@/lib/copilot/generative-ui";

const nativeOffer = () => ({
  context: [
    { description: "Keep", value: "Supplied facts" },
    { description: "HTML design", value: GENERATIVE_UI_DESIGN_SKILL },
  ],
  forwardedProps: {
    copilotkit: { ui: { "1.0": { supportedCatalogIds: ["openbot/ui@1"] } } },
  },
});

test("other Bots and an unread profile retain their exact context and catalog offer", () => {
  for (const packageBotId of [null, undefined, "another-package"]) {
    const input = nativeOffer();
    expect(withPersonalAssistantUiGuidance(input, packageBotId)).toBe(input);
    expect(input.context[1]?.value).toBe(GENERATIVE_UI_DESIGN_SKILL);
  }
});

test("no native guidance is added while the native catalog is unavailable", () => {
  for (const forwardedProps of [
    undefined,
    {},
    { copilotkit: {} },
    { copilotkit: { ui: {} } },
    { copilotkit: { ui: { "1.0": { supportedCatalogIds: [] } } } },
  ]) {
    const input = { ...nativeOffer(), forwardedProps };
    expect(withPersonalAssistantUiGuidance(input, "personal-assistant")).toBe(
      input,
    );
  }
});

test("each starter PA receives native guidance without changing the source context", () => {
  for (const packageBotId of ["personal-assistant", "picked-harness"]) {
    const input = nativeOffer();
    const result = withPersonalAssistantUiGuidance(input, packageBotId);
    expect(result.forwardedProps).toBe(input.forwardedProps);
    expect(result.context[0]).toBe(input.context[0]);
    expect(result.context[1]?.value).toEndWith(GENERATIVE_UI_DESIGN_SKILL);
    expect(result.context[1]?.value).not.toBe(GENERATIVE_UI_DESIGN_SKILL);
    expect(result.context.at(-1)?.value).toBe(PERSONAL_ASSISTANT_UI_GUIDANCE);
    expect(input.context).toHaveLength(2);
    expect(input.context[1]?.value).toBe(GENERATIVE_UI_DESIGN_SKILL);
    expect(withPersonalAssistantUiGuidance(result, packageBotId)).toBe(result);
  }
});

test("native guidance does not require the optional HTML guide or earlier context entries", () => {
  const input = nativeOffer();
  input.context = [];
  const result = withPersonalAssistantUiGuidance(input, "personal-assistant");
  expect(result.context).toEqual([
    {
      description: "Personal Assistant native A2UI guidance.",
      value: PERSONAL_ASSISTANT_UI_GUIDANCE,
    },
  ]);
});
