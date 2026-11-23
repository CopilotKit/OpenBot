import { describe, expect, test } from "bun:test";
import {
  buildFindings,
  classifyMoves,
  FINDING_KINDS,
  filterFindings,
  findingFiles,
  findingId,
  findingKey,
  findingPrompt,
  isExpected,
  isLayoutKind,
  KIND_LABELS,
  type Movement,
  matchWarning,
  moveWords,
  NO_FILTER,
  normalizeMessage,
  type Occurrence,
  occurrenceQuery,
  occurrenceSize,
  PROBLEM_SEVERITY,
  parseMark,
  type SceneRef,
  SPACING_RULE,
  SPACING_WHY,
  sortFindings,
  splitWarnings,
  userActions,
  warningMark,
} from "./findings";
import type { ScreenMark, Warning } from "./layoutWatch";
import { DEFAULT_WINDOW } from "./urlState";
import { warningKey } from "./WarningsList";

const INSTALL: SceneRef = {
  id: "install-mac",
  title: "Install on a Mac",
  group: "Install",
  kind: "desktop",
};
const UPDATE: SceneRef = {
  id: "update",
  title: "Update",
  group: "Update",
  kind: "desktop",
};
const HOME: SceneRef = {
  id: "app-home-bots",
  title: "Home with Bots",
  group: "App: Home",
  kind: "app",
};

const BOX = { x: 10, y: 200, width: 300, height: 20 };
const CHAIN = [
  { name: "Step", file: "desktop/src/Step.tsx", line: 12 },
  { name: "Setup", file: "desktop/src/Setup.tsx", line: 40 },
];

function moved(
  scene: SceneRef,
  at: number,
  dy: number,
  overrides: Partial<Occurrence> = {},
): Occurrence {
  const warning: Warning = {
    kind: "moved",
    at,
    label: 'span "Installing OpenBot in the background"',
    dx: 0,
    dy,
    cause: "command install",
    from: BOX,
    to: { ...BOX, y: BOX.y + dy },
  };
  return {
    scene,
    at,
    kind: "moved",
    label: warning.label,
    elementKey: "span:Installing OpenBot in the background",
    chain: CHAIN,
    warning,
    ...overrides,
  };
}

function clipped(scene: SceneRef, at: number, hidden: number): Occurrence {
  const warning: Warning = {
    kind: "clipped",
    at,
    label: 'p "A long line"',
    box: BOX,
    scrollWidth: BOX.width,
    scrollHeight: BOX.height + hidden,
  };
  return {
    scene,
    at,
    kind: "clipped",
    label: warning.label,
    elementKey: "p:A long line",
    chain: [{ name: "Card", file: "app/src/Card.tsx", line: 3 }],
    warning,
  };
}

function problem(
  scene: SceneRef,
  at: number,
  kind: Occurrence["kind"],
  label: string,
): Occurrence {
  return { scene, at, kind, label, elementKey: null, chain: [], warning: null };
}

describe("findings", () => {
  test("merges the same move in several scenes into one finding", () => {
    const findings = buildFindings([
      moved(INSTALL, 44_000, -157),
      moved(UPDATE, 3_000, -158),
      moved(INSTALL, 50_000, -156),
    ]);
    expect(findings).toHaveLength(1);
    const [f] = findings;
    expect(f?.sceneCount).toBe(2);
    expect(f?.occurrences.map((o) => `${o.scene.id}@${o.at}`)).toEqual([
      "install-mac@44000",
      "install-mac@50000",
      "update@3000",
    ]);
    expect(f?.title).toBe(
      'span "Installing OpenBot in the background" moves 158 px up',
    );
    expect(f?.severity).toBe(158);
    expect(f?.size).toBe(158);
    expect(f?.component).toEqual(CHAIN[0] ?? null);
    expect(f?.firstAt).toBe(3_000);
  });

  test("keeps apart moves of another size, element, file or kind", () => {
    const base = moved(INSTALL, 1_000, -157);
    const keys = new Set(
      [
        base,
        moved(INSTALL, 1_000, -40),
        moved(INSTALL, 1_000, -157, { elementKey: "span:Other" }),
        moved(INSTALL, 1_000, -157, {
          chain: [{ name: "Other", file: "desktop/src/Other.tsx" }],
        }),
        clipped(INSTALL, 1_000, 12),
      ].map(findingKey),
    );
    expect(keys.size).toBe(5);
    // A move of a pixel more falls in the same 4 px bucket.
    expect(findingKey(moved(UPDATE, 9_000, -158))).toBe(findingKey(base));
    expect(findingKey(base)).toBe(
      "moved|span:Installing OpenBot in the background|desktop/src/Step.tsx|0,-156",
    );
  });

  test("an occurrence whose element was gone merges with one that found it", () => {
    const findings = buildFindings([
      moved(INSTALL, 1_000, -157),
      moved(UPDATE, 2_000, -157, { elementKey: null, chain: [] }),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.sceneCount).toBe(2);
    expect(findings[0]?.occurrences[1]?.chain).toEqual(CHAIN);
  });

  test("uses the label when the element was not found", () => {
    const o = moved(INSTALL, 1_000, -20, { elementKey: null, chain: [] });
    expect(findingKey(o)).toBe(
      'moved|span "Installing OpenBot in the background"||0,-20',
    );
  });

  test("severity: px for layout, fixed and higher for problems", () => {
    const findings = buildFindings([
      moved(INSTALL, 1_000, -30),
      clipped(HOME, 2_000, 60),
      problem(
        HOME,
        0,
        "no-answer",
        "No answer for GET /api/v2/organizations/default/bots",
      ),
      problem(
        INSTALL,
        4_000,
        "stalled",
        "The run stalled: no frame in 10000 ms",
      ),
    ]);
    expect(findings.map((f) => [f.kind, f.severity])).toEqual([
      ["no-answer", PROBLEM_SEVERITY],
      ["stalled", PROBLEM_SEVERITY],
      ["clipped", 60],
      ["moved", 30],
    ]);
    expect(findings[2]?.title).toBe('p "A long line" is cut off by 60 px');
    expect(findings[0]?.size).toBeNull();
  });

  test("sizes: moved, clipped, outside", () => {
    expect(occurrenceSize(moved(INSTALL, 0, -157))).toBe(157);
    expect(occurrenceSize(clipped(INSTALL, 0, 9.6))).toBe(10);
    const outside: Occurrence = {
      ...problem(INSTALL, 0, "outside", 'button "Go"'),
      warning: {
        kind: "outside",
        at: 0,
        label: 'button "Go"',
        overBy: 31.4,
        box: BOX,
      },
    };
    expect(occurrenceSize(outside)).toBe(31);
  });

  test("ids are stable and follow the key", () => {
    const a = buildFindings([moved(INSTALL, 1_000, -157)])[0];
    const b = buildFindings([moved(UPDATE, 7_000, -157)])[0];
    expect(a?.id).toBe(b?.id ?? "");
    expect(a?.id).toBe(findingId(a?.key ?? ""));
    expect(a?.id).toMatch(/^f[0-9a-f]{8}$/);
    expect(findingId("x")).not.toBe(findingId("y"));
    // Pinned, so a change of the hash is a change of every link and every saved id.
    expect(findingId("moved|a||0,0")).toBe("f43698589");
  });

  test("problem keys ignore ids and numbers", () => {
    expect(
      normalizeMessage(
        "No answer for GET /api/v2/bots/0f3a9c2e-1111-2222-3333-444455556666",
      ),
    ).toBe("No answer for GET /api/v2/bots/:id");
    const a = problem(
      HOME,
      0,
      "stalled",
      "The run stalled: no frame in 10000 ms",
    );
    const b = problem(
      UPDATE,
      0,
      "stalled",
      "The run stalled: no frame in 3000 ms",
    );
    expect(findingKey(a)).toBe(findingKey(b));
  });

  test("move words", () => {
    expect(moveWords(0, -157)).toBe("157 px up");
    expect(moveWords(40, 2)).toBe("40 px right");
    expect(moveWords(-12, 30)).toBe("30 px down and 12 px left");
  });

  test("sorts by size, scenes and time", () => {
    const findings = buildFindings([
      moved(INSTALL, 9_000, -100),
      moved(INSTALL, 1_000, -20),
      moved(UPDATE, 2_000, -20),
      clipped(HOME, 5_000, 40),
    ]);
    expect(sortFindings(findings, "size").map((f) => f.size)).toEqual([
      100, 40, 20,
    ]);
    expect(sortFindings(findings, "scenes").map((f) => f.size)).toEqual([
      20, 100, 40,
    ]);
    expect(sortFindings(findings, "time").map((f) => f.firstAt)).toEqual([
      1_000, 5_000, 9_000,
    ]);
  });

  test("filters by kind, window, file, size and text", () => {
    const findings = buildFindings([
      moved(INSTALL, 9_000, -100),
      clipped(HOME, 5_000, 40),
      problem(HOME, 0, "app-error", "Error in the app: boom"),
    ]);
    const count = (filter: Partial<typeof NO_FILTER>) =>
      filterFindings(findings, { ...NO_FILTER, ...filter }).length;
    expect(count({})).toBe(3);
    expect(count({ kind: "clipped" })).toBe(1);
    expect(count({ window: "app" })).toBe(2);
    expect(count({ window: "desktop" })).toBe(1);
    expect(count({ file: "app/src/Card.tsx" })).toBe(1);
    expect(count({ minSize: 50 })).toBe(2);
    expect(count({ text: "install on a mac" })).toBe(1);
    expect(count({ text: "BOOM" })).toBe(1);
    expect(findingFiles(findings)).toEqual([
      "app/src/Card.tsx",
      "desktop/src/Step.tsx",
    ]);
  });
});

describe("marks", () => {
  const warning = moved(INSTALL, 44_123, -157).warning as Warning;

  test("a mark is the warnings list key", () => {
    expect(warningMark(warning)).toBe(warningKey(warning));
  });

  test("parses a mark and refuses a bad one", () => {
    expect(parseMark(warningMark(warning))).toEqual({
      kind: "moved",
      at: 44_123,
      label: warning.label,
    });
    expect(parseMark('clipped|10|p "a|b"')?.label).toBe('p "a|b"');
    expect(parseMark(null)).toBeNull();
    expect(parseMark("moved|soon|x")).toBeNull();
    expect(parseMark("gone|10|x")).toBeNull();
  });

  test("matches the nearest warning of the same kind and label", () => {
    const mark = { kind: "moved" as const, at: 44_000, label: warning.label };
    const near = { ...warning, at: 44_300 };
    const nearer = { ...warning, at: 43_950 };
    const far = { ...warning, at: 46_000 };
    expect(matchWarning([far, near, nearer], mark)).toBe(nearer);
    expect(matchWarning([far], mark)).toBeNull();
    expect(matchWarning([{ ...warning, label: "other" }], mark)).toBeNull();
  });
});

describe("links and prompts", () => {
  test("a link opens the scene at or before the occurrence, with the mark and no zoom", () => {
    const o = moved(INSTALL, 44_169, -157);
    const params = new URLSearchParams(
      occurrenceQuery(o, DEFAULT_WINDOW, { embed: true }),
    );
    expect(params.get("scene")).toBe("install-mac");
    expect(params.get("at")).toBe("44.1");
    expect(params.has("zoom")).toBe(false);
    expect(params.get("embed")).toBe("1");
    expect(params.get("mark")).toBe(warningMark(o.warning as Warning));
    const problemLink = new URLSearchParams(
      occurrenceQuery(
        problem(HOME, 2_000, "app-error", "boom"),
        DEFAULT_WINDOW,
      ),
    );
    expect(problemLink.has("mark")).toBe(false);
    expect(problemLink.has("embed")).toBe(false);
  });

  test("the prompt names the finding, its file and every occurrence", () => {
    const findings = buildFindings([
      moved(INSTALL, 44_000, -157),
      moved(UPDATE, 3_000, -157),
    ]);
    const f = findings[0];
    if (!f) throw new Error("no finding");
    const prompt = findingPrompt(f, f.occurrences[0] as Occurrence, {
      window: DEFAULT_WINDOW,
      origin: "http://localhost:3021",
    });
    expect(prompt).toContain(
      "# Change request from the OpenBot Desktop workbench",
    );
    expect(prompt).toContain(f.title);
    expect(prompt).toContain("desktop/src/Step.tsx:12");
    expect(prompt).toContain(
      "Install on a Mac (`install-mac`) at 0:44 (command install)",
    );
    expect(prompt).toContain("Update (`update`) at 0:03");
    expect(prompt).toContain(
      "http://localhost:3021/workbench/?scene=install-mac",
    );
    expect(prompt).toContain(
      '- Label: `span "Installing OpenBot in the background"`',
    );
  });

  test("the prompt of a problem has no element", () => {
    const f = buildFindings([
      problem(HOME, 0, "app-error", "Error in the app: boom"),
    ])[0];
    if (!f) throw new Error("no finding");
    const prompt = findingPrompt(f, f.occurrences[0] as Occurrence, {
      window: DEFAULT_WINDOW,
      origin: "http://localhost:3021",
    });
    expect(prompt).toContain("Error in the app: boom");
    expect(prompt).toContain("Search the repo");
    expect(prompt).not.toContain("- Label:");
  });
});

describe("movement classes", () => {
  const SETUP = "/workbench/frame.html#setup · Finishing setup";
  const screen = (at: number, name = SETUP, focus: string | null = null) =>
    ({ at, screen: name, focus }) satisfies ScreenMark;
  const move = (at: number, label: string, dy: number, dx = 0): Warning => ({
    kind: "moved",
    at,
    label,
    dx,
    dy,
    cause: "clock",
    from: BOX,
    to: { ...BOX, y: BOX.y + dy },
  });
  const classOf = (
    classes: Map<string, Movement>,
    w: Warning,
  ): Movement | undefined => classes.get(warningMark(w));

  test("reads the actions of a run", () => {
    expect(
      userActions([
        { at: 2, type: "sk-test", into: "API key" },
        { at: 1, click: "Install" },
        { at: 3, navigate: "/settings" },
        { at: 4, emit: "setup:progress", payload: {} },
      ]),
    ).toEqual([
      { at: 1000, kind: "click", target: "Install" },
      { at: 2000, kind: "type", target: "API key" },
      { at: 3000, kind: "navigate", target: "/settings" },
    ]);
  });

  test("a move within 500 ms after an input is expected", () => {
    const w = move(1_200, 'span "Installing"', -40);
    const c = classOf(
      classifyMoves(
        [w],
        [{ at: 1_000, kind: "click", target: "Install" }],
        [screen(0)],
      ),
      w,
    );
    expect(c?.class).toBe("expected");
    expect(c?.rule).toBe("after-action");
    expect(c?.why).toBe('moved 40 px 200 ms after the click on "Install"');
  });

  test("a move when the screen changes is expected", () => {
    const w = move(9_000, 'span "Step 2 of 4"', 30);
    const c = classOf(
      classifyMoves([w], [], [screen(0, "/a · Install"), screen(9_000)]),
      w,
    );
    expect(c?.rule).toBe("screen-change");
    expect(c?.class).toBe("expected");
    expect(c?.why).toContain('from "Install" to "Finishing setup"');
  });

  test("splitWarnings hides the expected moves and keeps jitter, cut off and outside", () => {
    const load = move(0, 'heading "Appearance"', 481);
    const jitters = [1_000, 2_000, 3_000].map((at, i) =>
      move(at, 'button "Continue"', i % 2 === 0 ? 30 : -30),
    );
    const cut: Warning = {
      kind: "clipped",
      at: 500,
      label: 'p "Long"',
      box: BOX,
      scrollWidth: 40,
      scrollHeight: 10,
    };
    const out: Warning = {
      kind: "outside",
      at: 500,
      label: 'p "Below"',
      overBy: 36,
      box: BOX,
    };
    const all = [load, ...jitters, cut, out];
    const classes = classifyMoves(all, [], [screen(0)]);
    const { shown, expected } = splitWarnings(all, classes);
    expect(expected).toEqual([load]);
    expect(shown).toEqual([...jitters, cut, out]);
    // A move with no class (not classified yet) shows.
    expect(splitWarnings([load], new Map()).shown).toEqual([load]);
    expect(isExpected(classOf(classes, load))).toBe(true);
    expect(isExpected(classOf(classes, jitters[0] as Warning))).toBe(false);
    expect(isExpected(null)).toBe(false);
  });

  test("moves while a screen loads are expected, and so is a late load shift", () => {
    const a = move(0, 'heading "Appearance"', 481);
    const b = move(500, 'heading "Appearance"', 20);
    const late = move(6_000, 'p "Usage"', 30);
    const classes = classifyMoves([a, b, late], [], [screen(0)]);
    expect(classOf(classes, a)?.rule).toBe("initial-load");
    expect(classOf(classes, b)?.rule).toBe("initial-load");
    expect(classOf(classes, late)?.rule).toBe("late-load");
    expect(classOf(classes, late)?.class).toBe("expected");
  });

  test("the element the next step types into moves: shift under hand", () => {
    const w = move(5_000, 'textbox "Base URL"', 40);
    const c = classOf(
      classifyMoves(
        [w],
        [{ at: 6_000, kind: "type", target: "Base URL" }],
        [screen(0)],
      ),
      w,
    );
    expect(c?.class).toBe("shift-under-hand");
    expect(c?.why).toBe(
      "moved 40 px while the person was about to type into it (the next step, at 0:06), with no input in the last 500 ms",
    );
  });

  test("the focused element or the one just clicked moves: shift under hand", () => {
    const focused = move(5_000, 'textbox "Base URL"', 40);
    expect(
      classOf(
        classifyMoves(
          [focused],
          [],
          [screen(0), screen(4_000, SETUP, 'textbox "Base URL"')],
        ),
        focused,
      )?.why,
    ).toContain("while it had the focus");
    const clicked = move(3_000, 'button "Install"', 24);
    expect(
      classOf(
        classifyMoves(
          [clicked],
          [{ at: 2_000, kind: "click", target: "Install" }],
          [screen(0)],
        ),
        clicked,
      )?.class,
    ).toBe("shift-under-hand");
    // The same move 300 ms after the click is the click's own.
    const soon = move(2_300, 'button "Install"', 24);
    expect(
      classOf(
        classifyMoves(
          [soon],
          [{ at: 2_000, kind: "click", target: "Install" }],
          [screen(0)],
        ),
        soon,
      )?.class,
    ).toBe("expected");
  });

  test("back and forth 3 times on the same screen with no input: jitter", () => {
    const label = 'span "Step 2 of 4"';
    const moves = [
      move(10_000, label, 7),
      move(20_000, label, -7),
      move(30_000, label, 13),
    ];
    const classes = classifyMoves(moves, [], [screen(0)]);
    for (const m of moves) {
      expect(classOf(classes, m)?.class).toBe("jitter");
      expect(classOf(classes, m)?.why).toBe(
        'moved up to 13 px 3 times on "Finishing setup" with no input',
      );
    }
    // An input between them breaks the series.
    const broken = classifyMoves(
      moves,
      [{ at: 15_000, kind: "click", target: "Other" }],
      [screen(0)],
    );
    expect(classOf(broken, moves[2] as Warning)?.class).toBe("expected");
    // Three moves the same way are not back and forth.
    const oneWay = [
      move(10_000, label, 7),
      move(20_000, label, 7),
      move(30_000, label, 7),
    ];
    expect(
      classOf(classifyMoves(oneWay, [], [screen(0)]), oneWay[0] as Warning)
        ?.rule,
    ).toBe("late-load");
  });

  test("findings: jitter merges, the bugs sort first, expected is hidden by default", () => {
    const label = 'span "Step 2 of 4"';
    const jitterAt = (at: number, dy: number): Occurrence => ({
      ...moved(INSTALL, at, dy),
      label,
      elementKey: "span:Step 2 of 4",
      warning: { ...(moved(INSTALL, at, dy).warning as Warning), label },
      movement: {
        class: "jitter",
        rule: "jitter",
        why: "moved up to 13 px 3 times",
      },
    });
    const hand: Occurrence = {
      ...moved(INSTALL, 5_000, 12, { elementKey: "textbox:Base URL" }),
      movement: {
        class: "shift-under-hand",
        rule: "shift-under-hand",
        why: "about to type",
      },
    };
    const expected: Occurrence = {
      ...moved(UPDATE, 0, 400, { elementKey: "heading:Appearance" }),
      movement: { class: "expected", rule: "initial-load", why: "loaded" },
    };
    const findings = buildFindings([
      jitterAt(10_000, 7),
      jitterAt(20_000, -7),
      jitterAt(30_000, 13),
      hand,
      expected,
      problem(HOME, 0, "app-error", "Error in the app: boom"),
    ]);
    expect(findings.map((f) => f.movement?.class ?? f.kind)).toEqual([
      "shift-under-hand",
      "jitter",
      "app-error",
      "expected",
    ]);
    const jitter = findings[1];
    expect(jitter?.occurrences).toHaveLength(3);
    expect(jitter?.title).toBe(
      'span "Step 2 of 4" moves back and forth, up to 13 px',
    );
    expect(
      filterFindings(findings, NO_FILTER).map(
        (f) => f.movement?.class ?? f.kind,
      ),
    ).toEqual(["shift-under-hand", "jitter", "app-error"]);
    expect(
      filterFindings(findings, { ...NO_FILTER, showExpected: true }),
    ).toHaveLength(4);
  });
});

describe("the Spacing class", () => {
  const CONNECTIONS: SceneRef = {
    id: "app-settings-connections",
    title: "Connections",
    group: "App: Settings",
    kind: "app",
  };
  const BUTTONS = { x: 21, y: 26.5, width: 52, height: 12 };
  function spacing(at: number, size: number): Occurrence {
    const warning: Warning = {
      kind: "spacing",
      at,
      label: 'panel <main data-slot="sidebar-inset">',
      rule: "clearance",
      box: { x: 73, y: 8, width: 919, height: 784 },
      buttons: BUTTONS,
      size,
      text: `panel <main data-slot="sidebar-inset"> is ${8 - size} px from the window buttons`,
    };
    return {
      scene: CONNECTIONS,
      at,
      kind: "spacing",
      label: warning.label,
      elementKey: null,
      chain: [],
      warning,
    };
  }

  test("a Spacing finding is a layout finding, titled by its sentence, sized by the rule", () => {
    const [finding] = buildFindings([spacing(0, 8), spacing(500, 8)]);
    expect(finding?.kind).toBe("spacing");
    expect(isLayoutKind("spacing")).toBe(true);
    expect(KIND_LABELS.spacing).toBe("Spacing");
    expect(finding?.title).toBe(
      'panel <main data-slot="sidebar-inset"> is 0 px from the window buttons',
    );
    expect(finding?.size).toBe(8);
    expect(finding?.occurrences).toHaveLength(2);
    expect(findingKey(spacing(0, 8))).toBe(
      'spacing|panel <main data-slot="sidebar-inset">||clearance,8',
    );
  });

  test("shown by default: Spacing is never an expected move", () => {
    const findings = buildFindings([spacing(0, 8)]);
    expect(filterFindings(findings, NO_FILTER)).toHaveLength(1);
    expect(
      filterFindings(findings, { ...NO_FILTER, kind: "spacing" }),
    ).toHaveLength(1);
    expect(FINDING_KINDS).toContain("spacing");
    expect(SPACING_RULE).toContain("8 px");
    expect(SPACING_WHY).toContain("TRAFFIC_LIGHTS");
  });

  test("a Spacing mark round-trips", () => {
    const warning = spacing(1200, 8).warning as Warning;
    const mark = parseMark(warningMark(warning));
    expect(warningMark(warning)).toBe(
      `spacing|1200|clearance|${warning.label}`,
    );
    expect(mark).toEqual({
      kind: "spacing",
      at: 1200,
      label: `clearance|${warning.label}`,
    });
    // The same panel under another rule at the same time is another warning.
    const row = { ...warning, rule: "row" } as Warning;
    expect(matchWarning([row, warning], mark as NonNullable<typeof mark>)).toBe(
      warning,
    );
    expect(matchWarning([warning], mark as NonNullable<typeof mark>)).toBe(
      warning,
    );
  });
});
