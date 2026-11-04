import { expect, test } from "bun:test";
import * as outcomes from "@openbot/shared/approval-outcomes";
import * as service from "../src/approvals/service";

/**
 * Every sentence the approval service answers a step with reaches a person in the person's words.
 *
 * The sentences are written to the Bot, and the app drew them as they stood: "The person did this
 * themselves. Do not repeat it; continue from what they have done." showed as a red refusal in the
 * Computer panel after the person pressed "I did it myself", and "Check whether it happened before
 * asking the person again" told them what the Bot should do next. Each was fixed by adding it to the
 * app's translation, and each was found by somebody reading the screen.
 *
 * So this walks what the service and the shared module export, rather than a list kept beside the
 * test: a sentence added to either is checked the day it is added. One written for the Bot talks
 * about "the person", or tells it what to do next; what the person reads must do neither.
 */

const WRITTEN_FOR_THE_BOT =
  /\bthe person\b|\bDo not\b|\bTry the action\b|\bcontinue from\b|\bbefore asking\b|\bwait for their answer\b|\byou asked\b/i;

/** A reason, as a builder of a sentence that carries one is given it. */
const REASON = "The disk is full.";

/** Every sentence the two modules can produce: their string constants, and what their builders make. */
function sentences(): string[] {
  const found = new Set<string>();
  for (const value of Object.values(service))
    if (typeof value === "string") found.add(value);
  for (const value of Object.values(outcomes)) {
    if (typeof value === "string") found.add(value);
    if (typeof value === "function" && value.length === 1) {
      const made: unknown = (value as (reason: string) => unknown)(REASON);
      if (typeof made === "string") found.add(made);
    }
  }
  return [...found];
}

test("the walk finds the sentences the server answers a step with", () => {
  const found = sentences();
  for (const sent of [
    outcomes.DECLINED_BY_PERSON,
    outcomes.ALREADY_WAITING,
    outcomes.WITHDRAWN_APPROVALS_OFF,
    outcomes.WITHDRAWN_RULE_ALLOWS,
    outcomes.HANDLED_BY_PERSON,
    outcomes.OUTCOME_UNKNOWN,
    outcomes.notDoneOnRecheck(REASON),
    outcomes.notCarriedOut(REASON),
  ]) {
    expect(found).toContain(sent);
    // Each is the Bot's as sent, which is what makes the check below mean anything.
    expect(sent).toMatch(WRITTEN_FOR_THE_BOT);
  }
  // And the service sends the shared ones, not copies of its own that could drift from them.
  expect(service.HANDLED_BY_PERSON).toBe(outcomes.HANDLED_BY_PERSON);
  expect(service.OUTCOME_UNKNOWN).toBe(outcomes.OUTCOME_UNKNOWN);
  expect(service.DECLINED_BY_PERSON).toBe(outcomes.DECLINED_BY_PERSON);
});

test("no sentence a person reads for a step is in the words written for the Bot", () => {
  const leaks = sentences()
    .map((sent) => ({ sent, read: outcomes.outcomeForPerson(sent) }))
    .filter(({ read }) => WRITTEN_FOR_THE_BOT.test(read));
  expect(leaks).toEqual([]);
});
