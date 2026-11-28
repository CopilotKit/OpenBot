import { describe, expect, test } from "bun:test";
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { offences, type Rule } from "./ui-look-rules";

/*
 * Guard: screens keep the web app's look (docs/app-guidelines.md, "The web app's look").
 *
 * The primitives in components/ui are the look; a screen draws with them and with the scheme's
 * tokens, and adds no corner, shadow, text size, dark-only color or hand-drawn card of its own.
 * Read: every .ts and .tsx under app/src, except components/ui, skins (whose looks are their own),
 * the generated API client and tests.
 *
 * Files drawn before these rules are counted in ui-look-guard.allowlist.json. The list only gets
 * shorter: a new offence fails, and so does a cleanup that leaves the list behind. After cleaning
 * a file up, write the new counts with
 *
 *   OPENBOT_UPDATE_UI_LOOK_ALLOWLIST=1 bun test app/tests/ui-look-guard.test.ts
 */

/** The rule's matches in one class string, as a screen would write it. */
const found = (rule: Rule, classes: string) =>
  offences(`const className = "${classes}";`)[rule];

describe("the rules", () => {
  const cases: Record<Rule, { finds: string[]; ignores: string[] }> = {
    corner: {
      finds: [
        "rounded-[20px]",
        "rounded-t-[10px]",
        "rounded-[min(var(--radius-md),10px)]",
      ],
      ignores: ["rounded-lg"],
    },
    cornerStep: {
      finds: ["rounded-sm", "rounded-2xl", "rounded", "rounded-t-3xl"],
      ignores: [
        "rounded-md",
        "rounded-lg",
        "rounded-xl",
        "rounded-full",
        "rounded-none",
      ],
    },
    shadow: {
      finds: ["shadow-[0_1px_2px_black]", "drop-shadow-[0_8px_24px_black]"],
      ignores: ["shadow-ring/25"],
    },
    shadowStep: {
      finds: ["shadow-sm", "shadow-md", "shadow-xl", "shadow"],
      ignores: [
        "shadow-xs",
        "shadow-lg",
        "shadow-2xl",
        "shadow-none",
        "shadow-ring/25",
      ],
    },
    text: {
      finds: [
        "text-[10px]",
        "text-[0.8rem]",
        "text-[1rem]/[1.5]",
        "text-[13px]/5",
      ],
      ignores: ["text-xs", "text-[color:var(--x)]"],
    },
    darkColor: {
      finds: [
        "dark:bg-input/30",
        "dark:hover:text-foreground",
        "dark:border-transparent",
      ],
      ignores: ["dark:hidden", "bg-card"],
    },
    card: {
      finds: [
        "rounded-lg border bg-card p-4",
        "bg-card border border-border rounded-xl",
      ],
      ignores: ["rounded-lg bg-card", "border bg-card"],
    },
  };

  for (const [rule, { finds, ignores }] of Object.entries(cases) as [
    Rule,
    { finds: string[]; ignores: string[] },
  ][]) {
    test(`${rule} finds what it forbids and nothing else`, () => {
      for (const classes of finds)
        expect({ classes, found: found(rule, classes).length }).toEqual({
          classes,
          found: 1,
        });
      for (const classes of ignores)
        expect({ classes, found: found(rule, classes).length }).toEqual({
          classes,
          found: 0,
        });
    });
  }

  test("a variant prefix does not hide a class", () => {
    expect(found("cornerStep", "hover:md:rounded-sm")).toEqual(["rounded-sm"]);
    expect(found("shadowStep", "group-data-[x]/item:shadow-md")).toEqual([
      "shadow-md",
    ]);
  });

  test("a class in a comment is not counted", () => {
    expect(
      offences(`// rounded-[20px]\n/* "shadow-md" */\nconst a = "p-4";`).corner,
    ).toEqual([]);
    expect(
      offences(`// rounded-[20px]\n/* "shadow-md" */\nconst a = "p-4";`)
        .shadowStep,
    ).toEqual([]);
  });

  test("single quotes and template literals are read too", () => {
    expect(offences("const a = 'rounded-sm';").cornerStep).toEqual([
      "rounded-sm",
    ]);
    // A source text holding a template literal with an expression in it.
    const template = "const a = `p-2 $" + "{b} shadow-md`;";
    expect(offences(template).shadowStep).toEqual(["shadow-md"]);
  });
});

const SRC = join(import.meta.dir, "../src");
const ALLOWLIST = join(import.meta.dir, "ui-look-guard.allowlist.json");
const NOT_READ = [
  "components/ui/",
  "skins/",
  "lib/api/generated/",
  // The message box's frame (rule 8): part of the look, kept beside the composer that uses it.
  "components/channels/composer/frame.ts",
];

type Counts = Partial<Record<Rule, number>>;

/** Every .ts and .tsx under app/src the guard reads, relative to it. */
function screenFiles(dir = SRC): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    const file = relative(SRC, path);
    if (NOT_READ.includes(file)) return [];
    if (statSync(path).isDirectory())
      return NOT_READ.some((skip) => `${file}/`.startsWith(skip))
        ? []
        : screenFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [file] : [];
  });
}

/** Each file's count per rule, only files and rules with at least one. */
function countAll(): Record<string, Counts> {
  const all: Record<string, Counts> = {};
  for (const file of screenFiles().sort()) {
    const found = offences(readFileSync(join(SRC, file), "utf8"));
    const counts: Counts = {};
    for (const [rule, list] of Object.entries(found) as [Rule, string[]][])
      if (list.length) counts[rule] = list.length;
    if (Object.keys(counts).length) all[file] = counts;
  }
  return all;
}

const actual = countAll();
if (process.env.OPENBOT_UPDATE_UI_LOOK_ALLOWLIST === "1")
  writeFileSync(ALLOWLIST, `${JSON.stringify(actual, null, 2)}\n`);
const allowed: Record<string, Counts> = existsSync(ALLOWLIST)
  ? JSON.parse(readFileSync(ALLOWLIST, "utf8"))
  : {};

describe("screens keep the look", () => {
  test("no file breaks a rule it did not already break", () => {
    const over: string[] = [];
    for (const [file, counts] of Object.entries(actual))
      for (const [rule, count] of Object.entries(counts) as [Rule, number][])
        if (count > (allowed[file]?.[rule] ?? 0))
          over.push(
            `${file}: ${rule} ${count} (allowed ${allowed[file]?.[rule] ?? 0})`,
          );
    expect(over).toEqual([]);
  });

  test("a cleaned file comes off the list", () => {
    const stale: string[] = [];
    for (const [file, counts] of Object.entries(allowed))
      for (const [rule, count] of Object.entries(counts) as [Rule, number][])
        if (count > (actual[file]?.[rule] ?? 0))
          stale.push(
            `${file}: ${rule} listed ${count}, now ${actual[file]?.[rule] ?? 0}`,
          );
    expect(stale).toEqual([]);
  });
});

/*
 * Files the look has been applied to. Each keeps to every rule, with nothing on the allowlist; a
 * screen joins this list when it is cleaned up.
 */
const CLEAN = [
  // The shell: the sidebar's strip and panel, and the frame the page sits in.
  "components/layout/strip.tsx",
  "components/layout/section-panel.tsx",
  "components/layout/sidebar-shell.tsx",
  "components/layout/page-shell.tsx",
  "components/app-sidebar/section-strip.tsx",
  "components/app-sidebar/app-sidebar.tsx",
  "components/app-sidebar/conversations-panel.tsx",
  "components/app-sidebar/bots-panel.tsx",
  "components/app-sidebar/channel.tsx",
  // Not channel-item-content.tsx: its time, Working label and preview line keep their 12px, which
  // no step on this scale draws (text-xs is 11.25px, text-sm 13.1px). They stay on the allowlist
  // with that reason, held by conversation-row-text.test.ts.
  // The message box.
  "components/channels/composer/composer.tsx",
  // Home, and a Bot's tile on it and on Bots.
  "routes/_authed/_app/index.tsx",
  "components/agents/agent-card.tsx",
  // Choosing a Bot for a new conversation.
  "routes/_authed/_app/channel/new.tsx",
  "components/channels/recipient-field.tsx",
  "components/channels/conversation-view.tsx",
  // A conversation.
  "routes/_authed/_app/channel/$channelId.tsx",
  "components/tasks/task-details.tsx",
  // Bots.
  "routes/_authed/_app/bots.index.tsx",
  "components/bots/bot-roster.tsx",
  // Settings.
  "routes/_authed/settings/index.tsx",
];

test("the files the look has been applied to keep every rule", () => {
  const broken = CLEAN.filter((file) => actual[file] !== undefined).map(
    (file) => `${file}: ${JSON.stringify(actual[file])}`,
  );
  expect(broken).toEqual([]);
});
