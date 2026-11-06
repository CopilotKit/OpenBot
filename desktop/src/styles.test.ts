/**
 * The setup window's update offer sits beside the steps, before `main`, over a fixed backdrop
 * (main.tsx). Two things went wrong with that arrangement, and both are rules in styles.css:
 *
 * - The backdrop is `position: fixed` at `z-index: 0`, which paints over anything in the page's flow
 *   that is not itself positioned. The offer was not, so it was on the page, clickable through the
 *   backdrop, and invisible.
 * - Each step was `min-height: 100vh` on its own. With the offer above it the page was always taller
 *   than the window, so fitWindow.ts asked for a taller window, the step grew with it, and the
 *   window kept growing to the edge of the screen.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const css = readFileSync(join(import.meta.dir, "styles.css"), "utf8");

/** The declarations of the one top-level rule for exactly `selector`. */
function rule(selector: string): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\#]/g, "\\$&");
  const found = [
    ...css.matchAll(new RegExp(`^${escaped} \\{([^}]*)\\}`, "gm")),
  ];
  expect(found.length).toBe(1);
  const body = (found[0]?.[1] ?? "").replace(/\/\*[\s\S]*?\*\//g, "");
  return Object.fromEntries(
    body
      .split(";")
      .map((declaration) => declaration.split(":").map((part) => part.trim()))
      .filter(([name, value]) => name && value)
      .map(([name, value]) => [name, value]),
  );
}

test("the update offer is painted above the fixed backdrop, as the step is", () => {
  const backdrop = rule(".backdrop");
  const offer = rule(".update-offer");
  const step = rule("main");
  expect(backdrop.position).toBe("fixed");
  for (const above of [offer, step]) {
    expect(above.position).toBe("relative");
    expect(Number(above["z-index"])).toBeGreaterThan(
      Number(backdrop["z-index"]),
    );
  }
});

test("the offer and the step together are never taller than the window by themselves", () => {
  expect(rule("#root")).toMatchObject({
    "min-height": "100vh",
    display: "flex",
    "flex-direction": "column",
  });
  const step = rule("main");
  expect(step["min-height"]).toBeUndefined();
  expect(step.flex).toBe("1 0 auto");
  expect(rule(".update-offer").flex).toBe("none");
});
