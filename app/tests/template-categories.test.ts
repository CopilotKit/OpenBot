import { expect, test } from "bun:test";
import { TEMPLATE_CATEGORIES as SHARED } from "../../shared/bot-template";
import {
  isTemplateCategory,
  TEMPLATE_CATEGORIES as APP,
  templateCategoryLabel,
} from "@/lib/templates/categories";

/**
 * The one list, written down twice.
 *
 * The closed category vocabulary exists in two files with nothing binding them: `shared` holds the
 * slugs the parser enforces, and the app holds slug-and-label pairs so the gallery can draw chips.
 * Neither imports the other — the app's list carries words that must never travel, and the parser
 * must not depend on the browser's vocabulary — so they agree only by hand.
 *
 * WHAT DRIFT LOOKS LIKE, and why typecheck cannot see it: the app derives its own
 * `TemplateCategorySlug` from its own array, and `isTemplateCategory` takes a plain string. Adding a
 * tenth category to `shared` alone therefore compiles, passes every gate, and ships a value the
 * server happily accepts and the gallery silently files under "Uncategorised" with no chip — a
 * template that exists on the server and is invisible in the only screen that lists templates.
 *
 * ORDER IS PART OF THE AGREEMENT, not incidental. The app's own doc comment says the array order is
 * the chip order and is deliberately not count order, so a reordering in `shared` that this test let
 * through would silently rearrange the filter row.
 */
test("the app draws exactly the categories the format accepts, in the same order", () => {
  expect(APP.map((category) => category.slug)).toEqual([...SHARED]);
});

test("every category the format accepts has a label to draw", () => {
  for (const slug of SHARED) {
    const label = templateCategoryLabel(slug);
    expect(label).toBeTruthy();
    expect(label).not.toBe(slug);
  }
});

/**
 * A category arrives as a string out of a stranger's file, so the guard is asked about values a
 * template could carry rather than only about the nine. A prototype member answering yes would draw
 * a chip labelled with JavaScript.
 */
test("nothing outside the list is treated as a category", () => {
  for (const value of [
    "constructor",
    "toString",
    "__proto__",
    "Sales",
    "Customer Success & Support",
    "",
    "aaa-sorts-first",
  ]) {
    expect(isTemplateCategory(value)).toBe(false);
  }
  expect(isTemplateCategory(null)).toBe(false);
  expect(isTemplateCategory(undefined)).toBe(false);
});
