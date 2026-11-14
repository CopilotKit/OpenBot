import { describe, expect, test } from "bun:test";
import {
  ASKING_GUIDANCE,
  BROUGHT_BOT_ASKING_GUIDANCE,
  COMPONENT_GUIDANCE,
  computerGuidance,
  DOCUMENT_GUIDANCE,
  HOW_TO_WORK_GUIDANCE,
  howToWorkGuidance,
  ORCHESTRATION_GUIDANCE,
  PROVENANCE_GUIDANCE,
  promptSection,
  REPLY_GUIDANCE,
  readsBack,
  runModeGuidance,
  workingGuidance,
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

  test("says what the computer has to run a script with, when the deployment says", () => {
    const guidance = flat(
      computerGuidance({
        search: true,
        installed: "Node.js, Bun, curl and unzip",
      }),
    );
    expect(guidance).toContain(
      "your computer runs ubuntu linux and has node.js, bun, curl and unzip installed",
    );
    expect(guidance).toContain(
      "never ask the person to approve a script for a program your computer does not have",
    );
    // A computer nobody here built is not described.
    expect(flat(WITH_SEARCH)).not.toContain("installed");
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

describe("a person who asks to type it themselves gets the browser", () => {
  /*
   * The computer-sign-in journey: "hand me the browser so I can type my password myself". In 2 of
   * 2 fresh live recordings the Bot called computer_request_secret (the masked box) instead, because
   * the guidance said a single value never hands over the whole browser and said nothing about a
   * person who asked to. The explicit request comes first, and the masked box is the otherwise.
   */
  test.each([
    ["with a search tool", WITH_SEARCH],
    ["without one", WITHOUT_SEARCH],
  ])(
    "an explicit request to take over comes before the masked box, %s",
    (_, guidance) => {
      const text = flat(guidance);
      const handOver = text.indexOf(
        "when the person says they will type it themselves, or asks you to hand them the browser or let them take over, call computer_request_help",
      );
      const maskedBox = text.indexOf(
        "otherwise, when you need a single value, a password, a code, a card number, do not hand over the whole browser. call computer_request_secret",
      );
      expect(handOver).toBeGreaterThan(-1);
      expect(maskedBox).toBeGreaterThan(handOver);
      expect(text).toContain("even for a single password");
    },
  );
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
      // The else-branch carries on with what was asked, and no further.
      expect(said).toContain(
        "say what you assumed, and carry on with what was asked",
      );
      expect(said).not.toContain("keep going");
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

  test("how to work acts on what was asked, waits for a tool search, and retries by kind", () => {
    const said = flat(HOW_TO_WORK_GUIDANCE);
    expect(said).toContain("do what was asked, at the scope it was asked");
    expect(said).toContain(
      "a question gets its answer, not the job it is about",
    );
    // A tool search that has not come back is not an answer that the tool is missing.
    expect(said).toContain(
      "wait for what it returns before you decide, or say, that something cannot be done",
    );
    expect(said).toContain("a step the person declined stays declined");
    expect(said).toContain(
      "never repeat a change only because you are not sure it went through",
    );
    expect(said).toContain(
      "look in the app first and redo only what is missing",
    );
    expect(said).toContain("stop and say briefly what failed");
  });

  test("nothing is made up in a call, and an empty search is tried another way", () => {
    const said = flat(HOW_TO_WORK_GUIDANCE);
    // A Bot searched an address it had invented, found nothing and said no such email existed.
    expect(said).toContain(
      "never make up an id, an address or a name to put in a call",
    );
    expect(said).toContain(
      "search for a person by the name you were given, not an address you guessed",
    );
    expect(said).toContain(
      "a search that finds nothing has not shown there is nothing",
    );
    expect(said).toContain("before you say something does not exist");
    // Said before the work, not only among the failed calls, where an empty result is no failure.
    expect(said.indexOf("never make up an id")).toBeLessThan(
      said.indexOf("when a call fails"),
    );
  });

  test("a claim needs a tool result, and an app change is read back once before it is called done", () => {
    const said = flat(HOW_TO_WORK_GUIDANCE);
    expect(said).toContain(
      "say something is done, sent, saved or correct only when a tool result in this conversation showed it",
    );
    expect(said).toContain(
      "after you change something in an app, read the result back once before you say it is done",
    );
    // Not a second read of what the change's own result already showed: on GPT-6.1 a Bot that
    // posted a Slack message then searched for it, read the channel twice and fetched its link.
    expect(said).toContain(
      "unless the change's own result already shows what changed, such as a sent message with its link",
    );
    expect(said).toContain("say 'all' only if you checked every item");
    // No aside about what was never looked at: a Slack summary said "no thread replies" with no
    // replies fetched.
    expect(said).toContain("leave out what you did not look at");
    expect(said).toContain(
      "no replies, nothing else or nothing newer unless a result showed that",
    );
    // Never the general plea Anthropic says makes its newest models over-verify.
    expect(said).not.toContain("double-check");
    expect(said).not.toContain("verify your work");
  });

  test("the read-back is left out for a model that reads its own work back", () => {
    for (const model of ["claude-opus-5-5", "claude-opus-5", "claude-opus-6"]) {
      expect(readsBack(model)).toBe(false);
      const said = flat(howToWorkGuidance(model));
      expect(said).not.toContain("read the result back once");
      // The claims rule stays for every model.
      expect(said).toContain(
        "only when a tool result in this conversation showed it",
      );
    }
    for (const model of [
      undefined,
      "claude-sonnet-5-5",
      "claude-haiku-5-5",
      "claude-opus-4-8",
      "gpt-6.1-sol",
      "gpt-5.6-terra",
      "gemini-3.8-flash",
    ]) {
      expect(readsBack(model)).toBe(true);
      expect(flat(howToWorkGuidance(model))).toContain(
        "read the result back once",
      );
    }
    const opus = workingGuidance({ untrusted: "x", model: "claude-opus-5-5" });
    expect(flat(opus.join(" "))).not.toContain("read the result back once");
  });

  test("a reply is sized to the question, and still draws what the answer calls for", () => {
    const said = flat(REPLY_GUIDANCE);
    expect(said).toContain("lead with the answer");
    expect(said).toContain("a yes-or-no question gets yes or no");
    // A question about ability gets yes or no, an offer and at most one question, not the work, a
    // capability list or a brief to fill in.
    expect(said).toContain(
      "a question about whether you can do something gets yes or no first",
    );
    expect(said).toContain("an offer to do it with at most one question");
    // Answered from the tools it holds, not from memory, and a limit is one sentence, not a list.
    expect(said).toContain(
      "answer from the tools you hold, searching for one first",
    );
    expect(said).toContain("say which part in one sentence");
    expect(said).toContain("do not do the work");
    // Nor a numbered list of everything it would need: one question now, the rest once started.
    expect(said).toContain(
      "list what you can and cannot do, list the details you would need, or ask for a brief",
    );
    expect(said).toContain("the rest can be asked once the work has started");
    // A request worded as a question is still a request.
    expect(said).toContain("a request worded as a question");
    expect(said).toContain("is a request: do it");
    expect(said).toContain("in one or two sentences");
    // Claude Sonnet 5.5 met the rule with a list of what it could and could not do; a worked
    // example of the shape wanted is what Anthropic says moves its models.
    expect(said).toContain("a good answer is: 'yes. who is it going to");
    // The example is not about an app a test asks about, and never says what an app's tools cannot
    // do: one that answered the Smartlead question with "Partly" was repeated to people whose
    // tools could do all of it.
    expect(said).not.toContain("smartlead");
    expect(said).not.toContain("partly");
    // A finished job: the result and its gaps, not a tour of what was built or an offer of more.
    expect(said).toContain(
      "then anything you could not confirm, a sentence each",
    );
    expect(said).toContain(
      "do not describe what you made when the link shows it",
    );
    expect(said).toContain("or offer more work");
    expect(said).toContain("recap your steps, repeat a summary");
    expect(said).toContain("do not announce or narrate your steps");
    // No preamble either: on GPT-6.1 a "one short line before a long job" became a message of its own.
    expect(said).not.toContain("one short line");
    expect(said).toContain("make sense on its own");
    // Generative UI is untouched by the length rule.
    expect(said).toContain(
      "a chart, table or card the answer calls for under the rules above is still drawn",
    );
  });

  test("a spreadsheet gets live formulas, labelled inputs, units, formats, one tab and a read-back", () => {
    const said = flat(DOCUMENT_GUIDANCE);
    expect(said).toContain("live formulas");
    expect(said).toContain("own labelled cell");
    expect(said).toContain(
      "never numbers you calculated yourself and typed in",
    );
    expect(said).toContain("units in the headers");
    expect(said).toContain("header row bold and freeze it");
    expect(said).toContain("percentages, currencies and dates");
    expect(said).toContain("keep a small task to one tab");
    expect(said).toContain("read back the tabs and cells you wrote");
    expect(said).toContain("#ref!");
    expect(said).toContain("no filler sections");
  });

  test("the push to act is said once, and every Bot gets the sections in order", () => {
    for (const brought of [false, true]) {
      const sections = workingGuidance({ brought, untrusted: "Untrusted." });
      const all = flat(sections.join(" "));
      expect(all.split("take it in the same reply").length - 1).toBe(1);
      expect(all).not.toContain("keep going");
      expect(sections.map((section) => /^<(\w+)>/.exec(section)?.[1])).toEqual([
        "how_to_work",
        "asking",
        "sources",
        "answer_format",
        "replies",
        "documents",
        "subagents",
        "untrusted_content",
      ]);
    }
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
    // "ID" is an acronym, not emphasis, and a spreadsheet's error codes (#REF!) are what it shows.
    for (const guidance of [
      HOW_TO_WORK_GUIDANCE,
      REPLY_GUIDANCE,
      DOCUMENT_GUIDANCE,
      ASKING_GUIDANCE,
      BROUGHT_BOT_ASKING_GUIDANCE,
      PROVENANCE_GUIDANCE,
      COMPONENT_GUIDANCE,
      ORCHESTRATION_GUIDANCE,
      runModeGuidance("routine"),
      runModeGuidance("check-in"),
    ])
      expect(
        (
          guidance.replace(/#[A-Z]+[!?]/g, "").match(/\b[A-Z]{2,}\b/g) ?? []
        ).filter((word) => word !== "ID"),
      ).toEqual([]);
  });
});
