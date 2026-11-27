import { describe, expect, test } from "bun:test";
import {
  buildCritiquePrompt,
  type CritiqueContext,
  critiqueTarget,
  type FrameElement,
  type FrameReport,
  MAX_ELEMENTS,
  mainSourceFile,
  shotCommand,
} from "./critiquePrompt";
import type { Warning } from "./layoutWatch";
import { DEFAULT_WINDOW } from "./urlState";

const box = { x: 4, y: 8, width: 100, height: 20 };

function el(label: string, files: string[]): FrameElement {
  return {
    key: label,
    label,
    box,
    chain: files.map((file, i) => ({ name: `C${i}`, file, line: 10 + i })),
  };
}

const desktopContext: CritiqueContext = {
  command: "critique",
  scene: { id: "install-mac", title: "Install on a Mac" },
  window: { ...DEFAULT_WINDOW, width: 1000, height: 800, os: "mac" },
  host: "desktop",
  hostFlag: null,
  link: "http://localhost:3021/workbench/?scene=install-mac",
};

const appContext: CritiqueContext = {
  ...desktopContext,
  command: "audit",
  scene: { id: "app-settings", title: "Settings" },
  host: "browser",
  hostFlag: "browser",
  route: "/settings",
};

const warning: Warning = {
  kind: "clipped",
  at: 37_000,
  label: 'span "Installing"',
  box: { x: 290, y: 347, width: 448, height: 22 },
  scrollWidth: 500,
  scrollHeight: 22,
};

describe("mainSourceFile", () => {
  test("picks the file that the most elements have in their chains", () => {
    const elements = [
      el("a", ["desktop/src/Sections.tsx", "desktop/src/App.tsx"]),
      el("b", ["desktop/src/App.tsx", "desktop/src/main.tsx"]),
      el("c", ["desktop/src/StartJourney.tsx", "desktop/src/App.tsx"]),
    ];
    expect(mainSourceFile(elements)).toBe("desktop/src/App.tsx");
  });

  test("counts a file once per element", () => {
    const elements = [
      el("a", ["desktop/src/A.tsx", "desktop/src/A.tsx", "desktop/src/A.tsx"]),
      el("b", ["desktop/src/B.tsx"]),
      el("c", ["desktop/src/B.tsx"]),
    ];
    expect(mainSourceFile(elements)).toBe("desktop/src/B.tsx");
  });

  test("skips the shared primitives, the shared layout, the entry files and other folders", () => {
    const elements = [
      el("a", [
        "app/src/components/ui/button.tsx",
        "app/src/components/layout/page-parts.tsx",
        "app/src/main.tsx",
        "desktop/workbench/Workbench.tsx",
        "app/src/components/settings/row.tsx",
      ]),
    ];
    expect(mainSourceFile(elements)).toBe(
      "app/src/components/settings/row.tsx",
    );
  });

  test("on a tie, a route file wins", () => {
    const elements = [
      el("a", [
        "app/src/components/settings/row.tsx",
        "app/src/routes/_authed/settings/index.tsx",
      ]),
    ];
    expect(mainSourceFile(elements)).toBe(
      "app/src/routes/_authed/settings/index.tsx",
    );
  });

  test("on a tie without routes, the file nearer to the elements wins", () => {
    const elements = [el("a", ["desktop/src/Z.tsx", "desktop/src/A.tsx"])];
    expect(mainSourceFile(elements)).toBe("desktop/src/Z.tsx");
  });

  test("is null without chains", () => {
    expect(mainSourceFile([{ label: "x", box }])).toBeNull();
  });
});

describe("critiqueTarget", () => {
  const empty: FrameReport = { kind: "app", elements: [], warnings: [] };
  test("falls back to the route, then to the scene id", () => {
    expect(critiqueTarget(empty, appContext)).toBe("/settings");
    expect(critiqueTarget(empty, desktopContext)).toBe("install-mac");
  });
});

describe("shotCommand", () => {
  test("captures the shared configuration link", () => {
    expect(shotCommand(desktopContext)).toContain(
      `--url '${desktopContext.link}'`,
    );
    expect(shotCommand(appContext)).not.toContain("--at");
  });
});

describe("buildCritiquePrompt", () => {
  const report: FrameReport = {
    kind: "desktop",
    elements: [
      el('heading "Finishing setup"', [
        "desktop/src/App.tsx",
        "desktop/src/main.tsx",
      ]),
    ],
    warnings: [warning],
  };
  const prompt = buildCritiquePrompt(report, desktopContext);
  const lines = prompt.split("\n");

  test("starts with the impeccable command and the target", () => {
    expect(lines[0]).toBe("/impeccable critique desktop/src/App.tsx");
  });

  test("names the mode, the visual truth and the frame", () => {
    expect(prompt).toContain("Operate.");
    expect(prompt).toContain(shotCommand(desktopContext));
    expect(prompt).toContain("Do NOT use impeccable's own `shot`");
    expect(prompt).toContain("- View: Install on a Mac (`install-mac`)");
    expect(prompt).toContain("- Window: 1000×800, OS mac, theme dark");
    expect(prompt).toContain(desktopContext.link);
  });

  test("lists the warnings as findings to check", () => {
    expect(prompt).toContain(
      '1. span "Installing" is cut off · box x 290, y 347, 448×22',
    );
  });

  test("lists the elements with component, file and box", () => {
    expect(prompt).toContain(
      '| heading "Finishing setup" | C0 | desktop/src/App.tsx:10 | x 4, y 8, 100×20 |',
    );
  });

  test("asks for findings by severity with file:line, the grid and the repo rules", () => {
    expect(prompt).toContain("ordered by severity");
    expect(prompt).toContain("`file:line`");
    expect(prompt).toContain("4px grid");
    expect(prompt).toContain("openbot-copy");
    expect(prompt).toContain("openbot-screen-layout");
  });

  test("says when there are no warnings", () => {
    const quiet = buildCritiquePrompt(
      { ...report, warnings: [] },
      desktopContext,
    );
    expect(quiet).toContain("no layout warnings");
  });

  test("names the host and route of an app frame", () => {
    const app = buildCritiquePrompt(
      { kind: "app", elements: [], warnings: [] },
      appContext,
    );
    expect(app.split("\n")[0]).toBe("/impeccable audit /settings");
    expect(app).toContain("- Host: Browser");
    expect(app).toContain("- Route: /settings");
    expect(app).toContain("under `app/src`");
  });

  test(`trims the elements to ${MAX_ELEMENTS}`, () => {
    const many = Array.from({ length: MAX_ELEMENTS + 5 }, (_, i) =>
      el(`item ${i}`, ["desktop/src/App.tsx"]),
    );
    const long = buildCritiquePrompt(
      { kind: "desktop", elements: many, warnings: [] },
      desktopContext,
    );
    expect(long).toContain(`| item ${MAX_ELEMENTS - 1} |`);
    expect(long).not.toContain(`| item ${MAX_ELEMENTS} |`);
    expect(long).toContain(
      `Showing the first ${MAX_ELEMENTS} of ${MAX_ELEMENTS + 5} elements.`,
    );
  });
});
