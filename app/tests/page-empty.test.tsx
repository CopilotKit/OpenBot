import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, render } from "@testing-library/react";
import { PageEmpty } from "@/components/layout/page-parts";
import { DEFAULT_SKIN, setSkin } from "@/skins/store";
import { settleReactWork } from "./settle-react-work";

/*
 * An empty state carries the empty-state pattern (`.empty-pattern`), which is decoration, so a
 * screen reader never meets it. A skin turns the pattern off through its tokens and keeps the plain
 * hairline box; OpenBot's own look gives the box a firmer edge and a faint wash.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(() => {
  cleanup();
  act(() => setSkin(DEFAULT_SKIN));
});
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

test("has the firmer edge in OpenBot's own look and the plain box in a skin", () => {
  const box = () =>
    renderEmpty().container.querySelector("[data-slot=empty]")?.className ?? "";
  expect(box()).toContain("--line-strong");
  cleanup();
  act(() => setSkin("openduet"));
  expect(box()).toContain("border-border");
  expect(box()).not.toContain("--line-strong");
});
