import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { Item, ItemContent, ItemTitle } from "@/components/ui/item";
import { settleReactWork } from "./settle-react-work";

/**
 * A row drawn as a button can be disabled — "Run now" while a run is starting — and has to look it,
 * or it reads as a button that ignores the click.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

test("a row drawn as a disabled button is dimmed and takes no pointer", () => {
  const view = render(
    <Item render={<button disabled type="button" />} size="sm">
      <ItemContent>
        <ItemTitle>Run now</ItemTitle>
      </ItemContent>
    </Item>,
  );
  const row = view.getByRole("button", { name: "Run now" });
  expect(row.hasAttribute("disabled")).toBe(true);
  expect(row.className).toContain("disabled:opacity-50");
  expect(row.className).toContain("disabled:pointer-events-none");
});
