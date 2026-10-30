import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { PageEmpty } from "@/components/layout/page-parts";
import { settleReactWork } from "./settle-react-work";

/*
 * An empty state carries the empty-state pattern (`.empty-pattern`), which is decoration, so a
 * screen reader never meets it. Its edge is the `--card-border` token; a skin turns the pattern off
 * and sets the edge back to its hairline through its tokens, which `design-tokens.test.ts` pins.
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

test("takes the card edge from its token, with no fill of its own", () => {
  const box =
    renderEmpty().container.querySelector("[data-slot=empty]")?.className ?? "";
  expect(box).toContain("border-card-border");
  expect(box).not.toContain("bg-");
});
