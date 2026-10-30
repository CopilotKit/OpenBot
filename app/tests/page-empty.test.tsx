import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { PageEmpty } from "@/components/layout/page-parts";
import { settleReactWork } from "./settle-react-work";

/*
 * An empty state carries the empty-state pattern (`.empty-pattern`). It is decoration, so a screen
 * reader never meets it. A skin turns it off through its tokens, which `design-tokens.test.ts` pins.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

function renderEmpty() {
  return render(
    <PageEmpty title="No Bots yet">Add a Bot and it shows up here.</PageEmpty>,
  );
}

test("renders its title and description", () => {
  const view = renderEmpty();
  expect(view.getByText("No Bots yet")).not.toBeNull();
  expect(view.getByText("Add a Bot and it shows up here.")).not.toBeNull();
});

test("draws the pattern, hidden from assistive technology", () => {
  const view = renderEmpty();
  const pattern = view.container.querySelector(".empty-pattern");
  expect(pattern).not.toBeNull();
  expect(pattern?.getAttribute("aria-hidden")).toBe("true");
});
