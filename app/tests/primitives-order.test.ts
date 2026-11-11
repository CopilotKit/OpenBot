import { expect, test } from "bun:test";
import { ADMIN_SECTIONS } from "@/components/admin/admin-sections";
import { SETTINGS_SIDEBAR_ITEMS } from "@/components/settings/settings-sidebar";
import { PRIMITIVES } from "@/lib/primitives";

/**
 * The eight keep one order wherever they are listed (`lib/primitives.ts`). A list may leave one
 * out and may hold other entries (Vault, Setup, Team); the ones it does hold never change places.
 * Checked against `PRIMITIVES` itself, so the order is written down once.
 */

const ORDER = PRIMITIVES.map((primitive) => primitive.label);

/** Where each of the eight sits in the fixed order, for the titles that are one of them. */
function positions(titles: readonly string[]): number[] {
  return titles
    .map((title) => ORDER.indexOf(title))
    .filter((position) => position !== -1);
}

function inOrder(positions: readonly number[]): boolean {
  return positions.every(
    (position, index) => index === 0 || position > (positions[index - 1] ?? -1),
  );
}

test.each([
  ["Admin's groups", ADMIN_SECTIONS.map((section) => section.title)],
  ["the Settings sidebar", SETTINGS_SIDEBAR_ITEMS.map((item) => item.title)],
])("%s list the eight in their one order", (_name, titles) => {
  const found = positions(titles);
  // A list that names none of them would pass an order check by saying nothing.
  expect(found.length).toBeGreaterThanOrEqual(5);
  expect(inOrder(found)).toBe(true);
});

test("the check fails a list that swaps two of the eight", () => {
  expect(inOrder(positions(["Routines", "Skills", "Memory"]))).toBe(false);
  expect(inOrder(positions(["Vault", "Routines", "Team", "Skills"]))).toBe(
    true,
  );
  // Naming one twice is out of order too.
  expect(inOrder(positions(["Skills", "Skills"]))).toBe(false);
});
