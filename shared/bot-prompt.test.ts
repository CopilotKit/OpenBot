import { describe, expect, test } from "bun:test";
import { computerGuidance } from "./bot-prompt";
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

  test("says what it is about to do before its first computer action", () => {
    // A first action can sit through a cold start; a sentence first means the wait has a reason.
    for (const search of [true, false]) {
      expect(computerGuidance({ search })).toContain(
        "Before your first computer action in a turn, say in one sentence what you are about to do and where.",
      );
    }
  });
});
