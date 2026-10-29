import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, render } from "@testing-library/react";
import { PageEmpty } from "@/components/layout/page-parts";
import { DEFAULT_SKIN, setSkin } from "@/skins/store";
import { settleReactWork } from "./settle-react-work";

/*
 * An empty state in OpenBot's own look carries a corner of the CopilotKit dot matrix. It is
 * decoration, so a screen reader never meets it, and a skin keeps the plain box it had before.
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

test("draws a dot corner that is hidden from assistive technology", () => {
  const view = renderEmpty();
  const dots = view.container.querySelector("[data-slot=empty-dots]");
  expect(dots).not.toBeNull();
  expect(dots?.getAttribute("aria-hidden")).toBe("true");
});

test("keeps the plain box while a skin is active", () => {
  act(() => setSkin("openduet"));
  const view = renderEmpty();
  expect(view.getByText("No Bots yet")).not.toBeNull();
  expect(view.container.querySelector("[data-slot=empty-dots]")).toBeNull();
});
