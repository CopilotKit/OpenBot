import { describe, expect, test } from "bun:test";
import {
  ASKING_GUIDANCE,
  BROUGHT_BOT_ASKING_GUIDANCE,
  COMPONENT_GUIDANCE,
  computerGuidance,
  HOW_TO_WORK_GUIDANCE,
  ORCHESTRATION_GUIDANCE,
  PROVENANCE_GUIDANCE,
  promptSection,
  runModeGuidance,
} from "./bot-prompt";
import { RESEARCH_APP_NAMES } from "./research";

const WITH_SEARCH = computerGuidance({ search: true });
const WITHOUT_SEARCH = computerGuidance({ search: false });

/** One sentence can span a source line break, which is not a fact about what the Bot is told. */
const flat = (text: string) => text.toLowerCase().replace(/\s+/g, " ");

describe("computerGuidance", () => {
  test.each([
    ["with a search tool", WITH_SEARCH],
    ["without one", WITHOUT_SEARCH],
  ])("keeps paragraph breaks as blank lines %s", (_, guidance) => {
    expect(guidance).toContain("\n\n");
    expect(guidance).not.toContain("  ");
    for (const paragraph of guidance.split("\n\n")) {
      expect(paragraph).not.toContain("\n");
      expect(paragraph.length).toBeGreaterThan(0);
    }
  });

  test.each([
    ["with a search tool", WITH_SEARCH],
    ["without one", WITHOUT_SEARCH],
  ])(
    "still says the computer can open a page the person names, %s",
    (_, guidance) => {
      expect(guidance).toContain(
        "You are a Bot with your own computer, a real web browser the person can watch you use.",
      );
      expect(flat(guidance)).toContain(
        "when you are asked to open, visit or read a particular web page, call computer_navigate",
      );
      expect(guidance).toContain(
        "Say what you found or did in plain language, briefly.",
      );
    },
  );

  test.each([
    ["with a search tool", WITH_SEARCH],
    ["without one", WITHOUT_SEARCH],
  ])(
    "no longer insists the Bot never says it cannot browse, %s",
    (_, guidance) => {
      // The emphatic line that out-argued the hedge beside it in the demo.
      expect(flat(guidance)).not.toContain("never claim you cannot browse");
      // "check" sent "check the latest on X" to the browser.
      expect(flat(guidance)).not.toContain("look at, open, visit, check");
    },
  );

  test("with a search tool, finding information goes to it and never to the browser", () => {
    const guidance = flat(WITH_SEARCH);
    expect(guidance).toContain(
      "finding information is not a job for your computer",
    );
    // The three phrasings the routing has to survive.
    expect(guidance).toContain("search for something");
    expect(guidance).toContain("find the latest on a subject");
    expect(guidance).toContain("find a few examples of something");
    expect(guidance).toContain("use your search tool");
    expect(guidance).toContain("do not open a search engine in your browser");
    // What the computer is still for.
    expect(guidance).toContain(
      "signing in, clicking through a site, filling in a form, or opening a page the person asked to see",
    );
    // Never told to navigate for a search, and never told it cannot search.
    expect(guidance).not.toMatch(/search[^.]*call computer_navigate/);
    expect(guidance).not.toContain("you do not hold a search tool");
    expect(guidance).not.toContain("cannot search");
  });

  test("without a search tool, the browser is never a search engine", () => {
    const guidance = flat(WITHOUT_SEARCH);
    expect(guidance).toContain("opening a page is not a web search");
    expect(guidance).toContain("never drive your browser to a search engine");
    for (const engine of ["google", "bing", "duckduckgo"])
      expect(guidance).toContain(engine);
    expect(guidance).not.toContain("use your search tool");
    // Conditional, not a claim: a search tool from Composio or a server added by URL is not
    // recognised by role, and a Bot holding one must not be told it holds none.
    expect(guidance).toContain("none of your tools searches the web");
    expect(guidance).not.toContain("you do not hold a search tool");
  });

  test("without a search tool, it answers marked as unchecked and offers a search app", () => {
    const guidance = flat(WITHOUT_SEARCH);
    expect(guidance).toContain("answer from what you already know");
    expect(guidance).toContain("you have not checked it against a source");
    expect(guidance).toContain("call it once in the conversation");
    expect(guidance).toContain("show_app_access");
    for (const name of RESEARCH_APP_NAMES)
      expect(guidance).toContain(name.toLowerCase());
    expect(guidance).toContain(
      "otherwise say an administrator can add a search app",
    );
    // Asked "can you search the web?", a Bot with only a browser once said yes.
    expect(guidance).toContain("cannot search");
  });

  test("says what it is doing with its first computer action, in the same reply", () => {
    // A first action can sit through a cold start; a sentence beside it means the wait has a reason.
    // Beside the call, never instead of it: a sentence that promises the action is not the action.
    for (const search of [true, false]) {
      const guidance = flat(computerGuidance({ search }));
      expect(guidance).toContain(
        "in the same reply as your first computer action in a turn, say in one sentence what you are doing and where",
      );
      expect(guidance).not.toContain("before your first computer action");
    }
  });

  test.each([
    ["with a search tool", WITH_SEARCH],
    ["without one", WITHOUT_SEARCH],
  ])("states its rules plainly, without shouting, %s", (_, guidance) => {
    // A model reading an emphatic rule beside a calm one picks the emphatic one, and current
    // models overtrigger on capitals. Tool names are lower case, so any capitalised word of two
    // letters or more is emphasis.
    const acronyms = new Set(["CAPTCHA"]);
    const shouted = (guidance.match(/\b[A-Z]{2,}\b/g) ?? []).filter(
      (word) => !acronyms.has(word),
    );
    expect(shouted).toEqual([]);
  });

  test("a policy refusal leaves that action undone and the rest of the task going", () => {
    // It used to say "and stop", which a Bot read as stopping the whole task.
    const guidance = flat(WITH_SEARCH);
    expect(guidance).toContain(
      "leave that action undone, and carry on with the rest of the task",
    );
    expect(guidance).not.toContain("and stop.");
  });
});

describe("how a Bot asks, and how an unattended run ends", () => {
  test("asking is a closed test, not a preference", () => {
    for (const guidance of [ASKING_GUIDANCE, BROUGHT_BOT_ASKING_GUIDANCE]) {
      const said = flat(guidance);
      // The three cases a question is for, and what to do otherwise.
      expect(said).toContain("only when you cannot go on without them");
      expect(said).toContain("a wrong guess would be hard to undo");
      expect(said).toContain("lead to materially different work");
      expect(said).toContain("only they know the answer");
      expect(said).toContain("say what you assumed, and keep going");
      // The open-ended cues that pulled a routine toward questions instead of an answer.
      expect(said).not.toContain("theirs to make");
      expect(said).not.toContain("prefer this to guessing");
    }
  });

  test("a brought Bot is told OpenBot asks only for what OpenBot gives it", () => {
    const said = flat(BROUGHT_BOT_ASKING_GUIDANCE);
    expect(said).toContain("when you use the apps and tools openbot gives you");
    expect(said).toContain(
      "tools of your own that openbot did not give you are not covered",
    );
    expect(flat(ASKING_GUIDANCE)).not.toContain("tools of your own");
  });

  test("how to work: reuse, batch a few reads, act instead of announcing, retry once, deliver", () => {
    const said = flat(HOW_TO_WORK_GUIDANCE);
    expect(said).toContain("use what you already have first");
    expect(said).toContain(
      "look it up directly instead of searching for it again",
    );
    expect(said).toContain("a few at a time");
    expect(said).toContain("read every result before the next batch");
    // Anthropic's sentence for parallel tool use, and a component drawn only from what was read.
    expect(said).toContain(
      "only batch tool calls that are independent of each other.",
    );
    expect(said).toContain(
      "draw a component only from results you have already read",
    );
    expect(said).toContain("never in the same step");
    expect(said).toContain(
      "take it in the same reply instead of saying you will",
    );
    expect(said).toContain("try once more or another way");
    expect(said).toContain(
      "deliver what was asked even when part of it is missing",
    );
  });

  test("a routine is told nobody is watching, to finish, and the shape of its report", () => {
    const said = flat(runModeGuidance("routine"));
    expect(said).toStartWith("nobody is watching this run");
    expect(said).toContain("carry them out without asking");
    expect(said).toContain("finish every other part");
    expect(said).toContain("read your last paragraph");
    // The report, in order: result, what could not be confirmed, questions, changes with links.
    const order = [
      "the result the routine asks for",
      "'what i could not confirm'",
      "any questions that still matter",
      "the changes you made in their apps, each with a link",
    ].map((part) => said.indexOf(part));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  test("a check-in runs unattended too, and keeps its own way of finishing", () => {
    const said = flat(runModeGuidance("check-in"));
    expect(said).toStartWith("nobody is watching this run");
    expect(said).toContain("do not stop to ask");
    expect(said).not.toContain("what i could not confirm");
  });

  test("a person's own turn is told nothing about a run mode", () => {
    expect(runModeGuidance("attended")).toBe("");
  });

  test("a section is a tag around its body, and nothing at all when the body is blank", () => {
    expect(promptSection("role", " Be helpful. ")).toEqual([
      "<role>\nBe helpful.\n</role>",
    ]);
    for (const blank of ["", "  \n ", null, undefined])
      expect(promptSection("role", blank)).toEqual([]);
  });

  test("no working rule shouts", () => {
    // "ID" is an acronym, not emphasis.
    for (const guidance of [
      HOW_TO_WORK_GUIDANCE,
      ASKING_GUIDANCE,
      BROUGHT_BOT_ASKING_GUIDANCE,
      PROVENANCE_GUIDANCE,
      COMPONENT_GUIDANCE,
      ORCHESTRATION_GUIDANCE,
      runModeGuidance("routine"),
      runModeGuidance("check-in"),
    ])
      expect(
        (guidance.match(/\b[A-Z]{2,}\b/g) ?? []).filter(
          (word) => word !== "ID",
        ),
      ).toEqual([]);
  });
});
