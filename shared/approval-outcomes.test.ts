import { expect, test } from "bun:test";
import * as outcomes from "./approval-outcomes";

// Read off the module, so a sentence it is missing fails the case about it, not the whole file.
const {
  ALREADY_WAITING,
  DECLINED_BY_PERSON,
  doneByPerson,
  HANDLED_BY_PERSON,
  OUTCOME_UNKNOWN,
  outcomeForPerson,
  WITHDRAWN_APPROVALS_OFF,
  WITHDRAWN_RULE_ALLOWS,
} = outcomes;

/*
 * A step that was not carried out comes back with a sentence written to the Bot, and the app drew it
 * as it stood: a person read "Do not try this action ... again" about their own decision. These are
 * the sentences the server sends (server/src/approvals/service.ts re-exports these constants), each
 * with what the person reads instead.
 */

test.each([
  [DECLINED_BY_PERSON, "You declined it."],
  [ALREADY_WAITING, "It's already waiting for your answer."],
  [WITHDRAWN_APPROVALS_OFF, "Withdrawn. You turned off asking before changes."],
  [WITHDRAWN_RULE_ALLOWS, "Withdrawn. A rule you saved now allows it."],
])("the server's sentence %#: the person reads their own", (sent, read) => {
  expect(outcomeForPerson(sent)).toBe(read);
});

test("a step the person did themselves reads as theirs, and as done", () => {
  // Word for word what the server answers after "I did it myself". It was drawn as a red refusal
  // reading "Do not repeat it; continue from what they have done."
  const sent =
    "The person did this themselves. Do not repeat it; continue from what they have done.";
  expect(outcomeForPerson(sent)).toBe("You did it yourself.");
  expect(sent).toBe(HANDLED_BY_PERSON);
  expect(doneByPerson(sent)).toBe(true);
  expect(doneByPerson(DECLINED_BY_PERSON)).toBe(false);
});

test("a step whose outcome is unknown says so without telling the person what the Bot should do next", () => {
  // Word for word what the server answers when the process running an approved step stopped before
  // saving what happened. Its ending, "before asking the person again", is the Bot's next step.
  const sent =
    "This action was started but its outcome is unknown. It was not repeated. Check whether it happened before asking the person again.";
  expect(outcomeForPerson(sent)).toBe(
    "It started, but OpenBot can't tell whether it finished. It wasn't run again.",
  );
  expect(sent).toBe(OUTCOME_UNKNOWN);
});

test("any other step not done keeps why, and loses the Bot's next step", () => {
  expect(
    outcomeForPerson(
      "Not done: The rule that allowed this was removed before it ran. Ask the person again if it is still needed.",
    ),
  ).toBe("Not done: The rule that allowed this was removed before it ran.");
  // A reason in parentheses can hold its own full stops; the sentence ends after them.
  expect(
    outcomeForPerson(
      "Not done: this action could not be carried out (the computer said: disk full. try later). Check whether it happened before asking the person again.",
    ),
  ).toBe(
    "Not done: this action could not be carried out (the computer said: disk full. try later).",
  );
});

test("a reason whose parentheses do not close still loses the Bot's next step", () => {
  // The reason is an error message as thrown. One with a stray "(" left the depth count above zero,
  // so no sentence end was found and the whole text, Bot's step included, reached the person.
  expect(
    outcomeForPerson(
      outcomes.notCarriedOut("Unexpected token ( in JSON at position 4"),
    ),
  ).toBe(
    "Not done: this action could not be carried out (Unexpected token ( in JSON at position 4).",
  );
  // A long reason is cut at 300 characters, which can drop its own closing ")".
  const long = `400 Invalid request (${"x".repeat(320)})`;
  const read = outcomeForPerson(outcomes.notCarriedOut(long));
  expect(read).not.toContain("before asking the person again");
  expect(read.endsWith(").")).toBe(true);
});

test("a long reason is cut between characters, not inside one", () => {
  const sent = outcomes.notCarriedOut(`${"a".repeat(299)}😀 and more`);
  expect(sent).toContain("😀)");
  // No lone surrogate: every UTF-16 high surrogate is followed by its low half.
  expect(sent).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
});

test("a boundary's or the computer's own sentence is already for a person, and is left as it is", () => {
  const boundary = "Commands that delete files are not allowed here.";
  expect(outcomeForPerson(boundary)).toBe(boundary);
  expect(outcomeForPerson("")).toBe("");
});

test("nothing a person reads tells them what the Bot should do next", () => {
  for (const sent of [
    DECLINED_BY_PERSON,
    ALREADY_WAITING,
    WITHDRAWN_APPROVALS_OFF,
    WITHDRAWN_RULE_ALLOWS,
    HANDLED_BY_PERSON,
    OUTCOME_UNKNOWN,
  ]) {
    const read = outcomeForPerson(sent);
    expect(read).not.toMatch(
      /\b(Do not|Try the action|Ask the person|wait for their answer)\b/,
    );
    expect(read).not.toMatch(/\byou asked\b/);
  }
});
