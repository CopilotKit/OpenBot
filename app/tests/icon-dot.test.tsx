import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { IconDot } from "@/components/ui/icon-dot";
import { settleReactWork } from "./settle-react-work";

/*
 * A status dot sits on the corner of its glyph. Rows lost the tile behind their icon (docs/app-
 * guidelines.md, "The look"), so a dot placed on the row's 32px media box floated in empty space.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

test("the dot is anchored to the glyph, not to the row's media box", () => {
  const view = render(
    <IconDot dotClassName="bg-success">
      <svg data-testid="glyph" />
    </IconDot>,
  );
  const glyph = view.getByTestId("glyph");
  const wrapper = glyph.parentElement as HTMLElement;
  const classes = (wrapper.getAttribute("class") ?? "").split(/\s+/);
  expect(classes).toEqual(expect.arrayContaining(["relative", "inline-flex"]));
  const dot = wrapper.querySelector("[data-slot=icon-dot]");
  expect(dot?.getAttribute("aria-hidden")).toBe("true");
  expect(dot?.getAttribute("class")).toContain("bg-success");
});

test("without a dot it draws the glyph alone", () => {
  const view = render(
    <IconDot>
      <svg data-testid="glyph" />
    </IconDot>,
  );
  expect(view.container.querySelector("[data-slot=icon-dot]")).toBeNull();
});

test.each([
  "../src/components/tasks/task-row.tsx",
  "../src/components/bot-profile/activity.tsx",
])("%s puts its dot on the glyph", (path) => {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  expect(source).toContain("<IconDot");
  expect(source).not.toContain("absolute -top-0.5 -right-0.5");
});
