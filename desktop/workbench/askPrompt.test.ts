import { describe, expect, test } from "bun:test";
import {
  ASK_CHOICES,
  buildAskPrompt,
  buildScreenPrompt,
  isAskFor,
  warningsIn,
} from "./askPrompt";
import {
  buildPrompt,
  type CommentContext,
  type PickedElement,
} from "./commentPrompt";
import type { Warning } from "./layoutWatch";

const context: CommentContext = {
  comment: "The title feels cramped",
  scene: { id: "install-mac", title: "Install on a Mac" },

  window: {
    width: 1000,
    height: 800,
    os: "mac",
    active: true,
    theme: "light",
    zoom: 1,
    grid: false,
  },
  link: "http://localhost:3021/workbench/?scene=install-mac&at=90",
};

const none = { top: null, right: null, bottom: null, left: null };

function el(label: string, file: string, y = 40): PickedElement {
  return {
    label,
    box: { x: 20, y, width: 200, height: 24 },
    gaps: none,
    offGrid: { x: 0, y: 0 },
    styles: {},
    chain: [{ name: "Title", file, line: 7 }],
    text: "",
  };
}

const inside: Warning = {
  kind: "clipped",
  at: 90_000,
  label: "h1 Install",
  box: { x: 30, y: 44, width: 50, height: 10 },
  scrollWidth: 80,
  scrollHeight: 10,
};
const outside: Warning = {
  ...inside,
  label: "footer",
  box: { x: 500, y: 700, width: 50, height: 10 },
};
const frame = { kind: "desktop" as const, warnings: [inside, outside] };

describe("the Ask for choice", () => {
  test("offers a change request and the six impeccable commands", () => {
    expect(ASK_CHOICES).toEqual([
      "change",
      "critique",
      "audit",
      "layout",
      "typeset",
      "clarify",
      "polish",
    ]);
    expect(isAskFor("polish")).toBe(true);
    expect(isAskFor("bolder")).toBe(false);
  });

  test("a change request is today's prompt", () => {
    const target = {
      kind: "element" as const,
      element: el("h1 Install", "desktop/src/Install.tsx"),
    };
    expect(buildAskPrompt("change", target, context, frame)).toBe(
      buildPrompt(target, context),
    );
  });

  test("an impeccable command on an element targets its file, in Operate, with the shot rule", () => {
    const prompt = buildAskPrompt(
      "typeset",
      { kind: "element", element: el("h1 Install", "desktop/src/Install.tsx") },
      context,
      frame,
    );
    expect(prompt.split("\n")[0]).toBe(
      "/impeccable typeset desktop/src/Install.tsx",
    );
    expect(prompt).toContain("## Surface mode");
    expect(prompt).toContain("Operate.");
    expect(prompt).toContain("Do NOT use impeccable's own `shot`");
    expect(prompt).toContain(
      "cd desktop && bun run desktop-workbench:shot --url",
    );
    // No image comes with a copied prompt: the agent renders the frame first.
    expect(prompt).toContain("No image comes with this prompt.");
    expect(prompt).not.toContain("frame.png in this folder");
    expect(prompt).toContain(
      'Review only this part of the frame: the element "h1 Install", at x 20, y 40, 200×24.',
    );
    expect(prompt).toContain("> The title feels cramped");
    // Only the warnings in the picked part.
    expect(prompt).toContain("h1 Install is cut off");
    expect(prompt).not.toContain("footer is cut off");
  });

  test("an area uses the file most of its elements share, and the words are optional", () => {
    const prompt = buildAskPrompt(
      "layout",
      {
        kind: "area",
        area: { x: 0, y: 0, width: 400, height: 200 },
        elements: [
          el("h1 Install", "desktop/src/Install.tsx", 40),
          el("p Lede", "desktop/src/Install.tsx", 80),
          el("button Next", "desktop/src/Footer.tsx", 120),
        ],
      },
      { ...context, comment: "  " },
      frame,
    );
    expect(prompt.split("\n")[0]).toBe(
      "/impeccable layout desktop/src/Install.tsx",
    );
    expect(prompt).toContain("an area with 3 elements, at x 0, y 0, 400×200");
    expect(prompt).not.toContain("## What the person asks");
  });

  test("an app scene names the route and passes the host to the shot", () => {
    const prompt = buildAskPrompt(
      "audit",
      { kind: "element", element: el("h2 AI", "app/src/routes/settings.tsx") },
      { ...context, app: { route: "/settings/ai", host: "browser" } },
      { kind: "app", warnings: [] },
    );
    expect(prompt).toContain("- Route: /settings/ai");
    expect(prompt).toContain("- Host: Browser");
    expect(prompt).toContain("The workbench found no layout warnings");
  });
});

describe("Critique this screen", () => {
  test("reviews the whole frame with every warning and no scope", () => {
    const { comment: _comment, ...rest } = context;
    const prompt = buildScreenPrompt(
      "critique",
      [el("h1 Install", "desktop/src/Install.tsx")],
      rest,
      frame,
    );
    expect(prompt.split("\n")[0]).toBe(
      "/impeccable critique desktop/src/Install.tsx",
    );
    expect(prompt).not.toContain("## Scope");
    expect(prompt).toContain("h1 Install is cut off");
    expect(prompt).toContain("footer is cut off");
  });

  test("with no elements the target is the scene", () => {
    const { comment: _comment, ...rest } = context;
    const prompt = buildScreenPrompt("polish", [], rest, frame);
    expect(prompt.split("\n")[0]).toBe("/impeccable polish install-mac");
  });
});

test("warningsIn keeps the warnings that touch the box; a move counts where it went", () => {
  const moved: Warning = {
    kind: "moved",
    at: 0,
    label: "Save",
    dx: 0,
    dy: 300,
    cause: "click",
    from: { x: 0, y: 0, width: 10, height: 10 },
    to: { x: 0, y: 300, width: 10, height: 10 },
  };
  expect(
    warningsIn([moved, inside], { x: 0, y: 290, width: 50, height: 50 }),
  ).toEqual([moved]);
});
