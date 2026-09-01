import { describe, expect, test } from "bun:test";
import { desktopOverlayProblem } from "@/components/computer/computer-view";

describe("the expanded computer error overlay", () => {
  test("does not cover a healthy VM when only the managed browser is closed", () => {
    expect(
      desktopOverlayProblem(
        "The browser is closed. Open it from the Browser icon on the computer desktop.",
        null,
      ),
    ).toBeNull();
  });

  test("shows a problem from the desktop connection itself", () => {
    expect(desktopOverlayProblem(null, "The display disconnected.")).toBe(
      "The display disconnected.",
    );
  });
});
