import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { IconBolt } from "@/components/icons";
import { PageEmpty } from "@/components/layout/page-parts";
import { clearSkin, setSkin } from "@/skins/store";
import { settleReactWork } from "./settle-react-work";

/*
 * The current kit draws an empty section as Figma does: one of the kit's rows in its empty state,
 * an edge with no fill. The legacy kit keeps shadcn's empty state, which carries the empty-state
 * pattern (`.empty-pattern`), decoration a screen reader never meets. Its edge is the plain
 * `--border`; a skin turns the pattern off through its tokens, which `design-tokens.test.ts` pins.
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

test("the current kit draws it as an outlined row, its icon on a tile and its action at the end", () => {
  const view = render(
    <PageEmpty
      action={<button type="button">New Bot</button>}
      icon={IconBolt}
      title="No Bots yet"
    >
      Add a Bot and it shows up here.
    </PageEmpty>,
  );
  const row = view.container.querySelector("[data-page-empty]");
  expect(row?.getAttribute("data-slot")).toBe("item");
  expect(row?.getAttribute("data-variant")).toBe("outline");
  expect(row?.querySelector("[data-slot=item-media] svg")).not.toBeNull();
  expect(
    row?.querySelector("[data-slot=item-actions] button")?.textContent,
  ).toBe("New Bot");
  expect(view.container.querySelector(".empty-pattern")).toBeNull();
});

test("the legacy kit draws the pattern, hidden from assistive technology", () => {
  setSkin("openduet");
  const view = renderEmpty();
  const pattern = view.container.querySelector(".empty-pattern");
  expect(pattern).not.toBeNull();
  expect(pattern?.getAttribute("aria-hidden")).toBe("true");
  clearSkin();
});

test("the legacy kit takes the card edge from its token, with no fill of its own", () => {
  setSkin("openduet");
  const box =
    renderEmpty().container.querySelector("[data-slot=empty]")?.className ?? "";
  clearSkin();
  expect(box).toContain("border-border");
  expect(box).not.toContain("bg-");
});
