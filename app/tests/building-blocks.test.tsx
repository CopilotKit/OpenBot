import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import {
  BuildingBlockSections,
  blockAvailability,
  splitBuildingBlocks,
} from "@/components/building-blocks";
import { ComponentPreview } from "@/components/component-preview";
import type { ComponentRecord } from "@/lib/components/queries";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

function row(over: Partial<ComponentRecord>): ComponentRecord {
  return {
    name: "a2ui.Text",
    title: "Text",
    kind: "text",
    draftDescription: "Plain text.",
    publishedDescription: "Plain text.",
    published: true,
    publishedAt: "2026-10-28T00:00:00Z",
    updatedBy: null,
    updatedAt: "2026-10-28T00:00:00Z",
    hasUnpublishedChanges: false,
    withheldFrom: [],
    functions: [],
    ...over,
  };
}

test("the gallery's components and the standard families are listed apart", () => {
  const { gallery, blocks } = splitBuildingBlocks([
    row({ name: "showTable", kind: "card" }),
    row({ name: "a2ui.Table", kind: "data" }),
  ]);
  expect(gallery.map((component) => component.name)).toEqual(["showTable"]);
  expect(blocks.map((component) => component.name)).toEqual(["a2ui.Table"]);
});

test("families are grouped in the catalog's order, and empty groups are left out", () => {
  const view = render(
    <BuildingBlockSections
      components={[
        row({ name: "a2ui.Table", title: "Table", kind: "data" }),
        row({ name: "a2ui.Column", title: "Column", kind: "layout" }),
      ]}
    />,
  );
  expect(
    [...view.container.querySelectorAll("h2")].map((h) => h.textContent),
  ).toEqual(["Layout", "Data"]);
  // The people's gallery says what each one is for, and links nowhere.
  expect(view.getAllByText("Plain text.")).toHaveLength(2);
  expect(view.container.querySelector("a")).toBeNull();
});

test("an admin sees where each family stands", () => {
  expect(blockAvailability(row({}))).toBe("On for every Bot");
  expect(blockAvailability(row({ withheldFrom: ["trips"] }))).toBe(
    "Off for 1 Bot",
  );
  expect(blockAvailability(row({ withheldFrom: ["a", "b"] }))).toBe(
    "Off for 2 Bots",
  );
  expect(blockAvailability(row({ published: false }))).toBe("Off");
});

test("a family's preview does not claim this build cannot draw it", () => {
  const view = render(<ComponentPreview name="a2ui.Table" />);
  expect(view.container.textContent).not.toContain("cannot draw");
});
