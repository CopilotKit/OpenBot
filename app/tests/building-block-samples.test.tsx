import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { GenerativeUIErrorInfo } from "@copilotkit/react-core/v2/generative-ui";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  STANDARD_UI_FAMILIES,
  standardUiComponentName,
} from "@openbot/shared/standard-ui";
import { cleanup, render, waitFor } from "@testing-library/react";
import { BuildingBlockPreview } from "@/components/building-block-preview";
import { BUILDING_BLOCK_SAMPLES } from "@/components/building-block-samples";
import { settleReactWork } from "./settle-react-work";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

test("every family has a sample", () => {
  expect(Object.keys(BUILDING_BLOCK_SAMPLES).sort()).toEqual(
    STANDARD_UI_FAMILIES.map((family) => family.head).sort(),
  );
});

for (const family of STANDARD_UI_FAMILIES) {
  test(`the ${family.head} sample draws without a rejection`, async () => {
    const errors: GenerativeUIErrorInfo[] = [];
    const view = render(
      <BuildingBlockPreview
        name={standardUiComponentName(family)}
        onError={(info) => errors.push(info)}
      />,
    );
    await waitFor(() =>
      expect(
        view.container.querySelector("[data-generative-ui-root]")
          ?.childElementCount,
      ).toBeGreaterThan(1),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(errors.map((info) => info.error.message)).toEqual([]);
  });
}
