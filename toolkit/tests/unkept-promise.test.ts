import { describe, expect, test } from "bun:test";
import { unkeptPromise } from "../src/copilotkit/unkept-promise";

/**
 * The rule that decides a run ended on a promise, held against what models actually write. The
 * promises are the routine that found this ("I'll fetch the rest now") and the shapes public agent
 * bug reports quote; the answers that are finished are ordinary endings that must never be sent back.
 */

describe("an answer that ends on a promise", () => {
  test.each([
    [
      "I've pulled 11 of the 20 issues. I'll fetch the rest now.",
      "I'll fetch the rest now.",
    ],
    [
      "Let me pull the remaining issues from Linear.",
      "Let me pull the remaining issues from Linear.",
    ],
    [
      "Next, I'll check the Candidates page in Notion.",
      "Next, I'll check the Candidates page in Notion.",
    ],
    [
      "I'm going to look up ENG-412 and ENG-418 next.",
      "I'm going to look up ENG-412 and ENG-418 next.",
    ],
    ["Doing it now.", "Doing it now."],
    [
      "Fetching the remaining 9 issues now.",
      "Fetching the remaining 9 issues now.",
    ],
    [
      "Now checking Notion for the matches.",
      "Now checking Notion for the matches.",
    ],
    ["Got the cycle. I’ll now go and rank them.", "I’ll now go and rank them."],
    [
      "I have the first batch. I'll fetch the remaining nine now, then rank them.\n\n- ENG-1: Todo\n- ENG-2: In Progress",
      "I'll fetch the remaining nine now, then rank them.",
    ],
  ])("%j", (answer, promise) => {
    expect(unkeptPromise(answer)).toBe(promise);
  });
});

describe("an answer that is finished, or is the person's to answer", () => {
  test.each([
    "Here is the ranked list. Let me know if you want it posted to Slack.",
    "Done. I'll be here if you need anything else.",
    "Do you want me to fetch the rest as well?",
    "I'll send the draft once you confirm the recipients.",
    "Posted the summary. I'll run again tomorrow at 9.",
    "Here's what I'll cover:",
    "The sync is running now and the numbers are up to date.",
    "ENG-1 is in Todo, ENG-2 is In Progress.",
    "I'll keep an eye on the cycle and flag anything that slips.",
    "",
  ])("%j", (answer) => {
    expect(unkeptPromise(answer)).toBeUndefined();
  });
});
