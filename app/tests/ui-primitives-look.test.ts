import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { classes, offences, type Rule } from "./ui-look-rules";

/*
 * The primitives draw the web app's look (docs/app-guidelines.md, "The look"). Shadows say how far
 * something floats, as Linear draws them: none in the page, `shadow-xs` on a control pressed on a
 * surface, `shadow-lg` and a border on what opens beside its trigger, `shadow-2xl` and a border on
 * what sits over the app. Corners come from `--radius`: controls md, cards lg, menus and dialogs xl.
 */

const UI = join(import.meta.dir, "../src/components/ui");
const FILES = readdirSync(UI).filter((name) => name.endsWith(".tsx"));
const source = (file: string) => readFileSync(join(UI, file), "utf8");
const has = (file: string, name: string) =>
  classes(source(file)).includes(name);

/** Steps the rules don't name, kept where a part needs them, each with its reason. */
const ALLOWED: Partial<Record<string, Partial<Record<Rule, string[]>>>> = {
  // A 16px box: the control corner (6.4px) would make it read as a radio.
  "checkbox.tsx": { cornerStep: ["rounded-sm"] },
  // The same 16px box, drawn for a questionnaire's choices.
  "questionnaire.tsx": { cornerStep: ["rounded-sm"] },
  // A line, not depth: the pinned header's rule. A collapsed table border belongs to the rows
  // and scrolls away with them, so the line is drawn inside the header instead.
  "table.tsx": { shadow: ["shadow-[inset_0_-1px_0_var(--color-border)]"] },
};

describe("the primitives keep the look", () => {
  test("no primitive has a corner or a shadow of its own", () => {
    const found = FILES.flatMap((file) => {
      const all = offences(source(file));
      return (["corner", "shadow"] as const).flatMap((rule) =>
        all[rule]
          .filter((name) => !ALLOWED[file]?.[rule]?.includes(name))
          .map((name) => `${file}: ${name}`),
      );
    });
    expect(found).toEqual([]);
  });

  test("no primitive uses a corner or shadow step the rules don't name", () => {
    const found = FILES.flatMap((file) => {
      const all = offences(source(file));
      return (["cornerStep", "shadowStep"] as const).flatMap((rule) =>
        all[rule]
          .filter((name) => !ALLOWED[file]?.[rule]?.includes(name))
          .map((name) => `${file}: ${name}`),
      );
    });
    expect(found).toEqual([]);
  });

  test.each([
    "popover.tsx",
    "dropdown-menu.tsx",
    "context-menu.tsx",
    "select.tsx",
    "combobox.tsx",
    "toast.tsx",
  ])(
    "%s floats beside its trigger: shadow-lg, a border, rounded-xl",
    (file) => {
      expect(has(file, "shadow-lg")).toBe(true);
      expect(has(file, "border-border")).toBe(true);
      expect(has(file, "rounded-xl")).toBe(true);
      expect(has(file, "ring-foreground/10")).toBe(false);
    },
  );

  test("a tooltip floats too, with a control's corner", () => {
    expect(has("tooltip.tsx", "shadow-lg")).toBe(true);
    expect(has("tooltip.tsx", "rounded-md")).toBe(true);
  });

  test.each(["dialog.tsx", "sheet.tsx"])(
    "%s sits over the app: shadow-2xl and a border",
    (file) => {
      expect(has(file, "shadow-2xl")).toBe(true);
      expect(has(file, "shadow-lg")).toBe(false);
    },
  );

  test("a dialog has the menu's corner", () => {
    expect(has("dialog.tsx", "rounded-xl")).toBe(true);
  });

  test.each([
    "button.tsx",
    "input.tsx",
    "textarea.tsx",
    "select.tsx",
    "input-group.tsx",
  ])("%s is a control: rounded-md, never rounded-lg", (file) => {
    expect(has(file, "rounded-md")).toBe(true);
    const lg = classes(source(file)).filter((name) =>
      /(^|:)rounded-lg$/.test(name),
    );
    expect(lg).toEqual([]);
  });

  test("a pressed control on a surface is raised: shadow-xs", () => {
    const outline =
      /outline:\s*"([^"]*)"/.exec(source("button.tsx"))?.[1] ?? "";
    expect(outline.split(/\s+/)).toContain("shadow-xs");
    expect(has("switch.tsx", "shadow-xs")).toBe(true);
    expect(
      classes(source("tabs.tsx")).some((name) =>
        name.endsWith("data-active:shadow-xs"),
      ),
    ).toBe(true);
  });

  test("the page's panel is flat, with the card's corner", () => {
    const inset = classes(source("sidebar.tsx")).filter((name) =>
      name.includes("peer-data-[variant=inset]:"),
    );
    expect(inset).toContain("md:peer-data-[variant=inset]:rounded-lg");
    expect(inset).toContain("md:peer-data-[variant=inset]:border");
    expect(inset.filter((name) => name.includes(":shadow-"))).toEqual([]);
  });

  test("no primitive overrides a color in dark: the token carries both", () => {
    const found = FILES.flatMap((file) =>
      offences(source(file)).darkColor.map((name) => `${file}: ${name}`),
    );
    expect(found).toEqual([]);
  });

  test.each(["input.tsx", "textarea.tsx", "select.tsx", "input-group.tsx"])(
    "%s stays a visible field in both themes: border-input on a surface",
    (file) => {
      expect(has(file, "border-input")).toBe(true);
      expect(has(file, "bg-card")).toBe(true);
    },
  );
});
