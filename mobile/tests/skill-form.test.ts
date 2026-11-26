/**
 * Writing a skill from the phone (src/skill-form.ts): the form as the request replaceSkill takes, with the web app's
 * limits, and who may change which skill.
 */
import { expect, test } from "bun:test";
import {
  EMPTY_SKILL_FORM,
  formOf,
  mayChange,
  SKILL_SLUG,
  skillRequest,
  slugFrom,
} from "../src/skill-form";

const form = {
  slug: "standup",
  title: "  Standup ",
  summary: " Writes today's standup. ",
  instructions: "\nRead my calendar, then write three lines.\n",
};

test("a new skill is sent trimmed, under its command, naming no actions", () => {
  expect(skillRequest(form, { creating: true })).toEqual({
    slug: "standup",
    body: {
      title: "Standup",
      summary: "Writes today's standup.",
      instructions: "Read my calendar, then write three lines.",
      tools: [],
    },
  });
});

test("a changed skill keeps the actions it named, since the phone doesn't change them and an empty list clears them", () => {
  const request = skillRequest(form, {
    creating: false,
    tools: ["google-calendar/list_events"],
  });
  expect("body" in request && request.body.tools).toEqual([
    "google-calendar/list_events",
  ]);
});

test("a new skill never takes a command already in use, which would quietly replace that skill", () => {
  expect(skillRequest(form, { creating: true, taken: ["standup"] })).toEqual({
    error: "A skill already uses /standup. Pick another command.",
  });
  // Changing a skill writes under its own command.
  expect(
    "body" in skillRequest(form, { creating: false, taken: ["standup"] }),
  ).toBe(true);
});

test("the form says what is missing or too long before anything is sent", () => {
  const without = (patch: Partial<typeof form>) =>
    skillRequest({ ...form, ...patch }, { creating: true });
  expect(without({ title: " " })).toEqual({ error: "Give the skill a name." });
  expect(without({ title: "x".repeat(121) })).toEqual({
    error: "The name must be 120 characters or fewer.",
  });
  expect(without({ slug: "" })).toEqual({ error: "Give the skill a command." });
  expect(without({ slug: "Stand Up" })).toEqual({
    error:
      "The command can use lower-case letters, numbers and hyphens, 2 to 40 characters.",
  });
  expect(without({ summary: "x".repeat(201) })).toEqual({
    error: "The one-line summary must be 200 characters or fewer.",
  });
  expect(without({ instructions: "  " })).toEqual({
    error: "Write the instructions. They are what the Bot follows.",
  });
});

test("the command's pattern is the server's: lower-case letters, digits and hyphens, 2 to 40, no hyphen at either end", () => {
  for (const slug of ["ab", "standup", "weekly-report-2", "a".repeat(40)])
    expect(SKILL_SLUG.test(slug)).toBe(true);
  for (const slug of ["a", "-ab", "ab-", "Ab", "a_b", "a".repeat(41)])
    expect(SKILL_SLUG.test(slug)).toBe(false);
});

test("a command is made from a name the way a person would write it", () => {
  expect(slugFrom("Daily standup")).toBe("daily-standup");
  expect(slugFrom("  Café notes!! ")).toBe("cafe-notes");
  expect(slugFrom("Q4 — review")).toBe("q4-review");
  expect(slugFrom(`${"x".repeat(39)} y`)).toBe("x".repeat(39));
  expect(SKILL_SLUG.test(slugFrom("A long name ".repeat(6)))).toBe(true);
});

test("the form opens filled with the skill it changes", () => {
  expect(
    formOf({
      slug: "standup",
      title: "Standup",
      summary: "",
      instructions: "Do it.",
    }),
  ).toEqual({
    slug: "standup",
    title: "Standup",
    summary: "",
    instructions: "Do it.",
  });
  expect(EMPTY_SKILL_FORM).toEqual({
    slug: "",
    title: "",
    summary: "",
    instructions: "",
  });
});

test("a person changes their own skills, and the organization's only in the personal edition", () => {
  const who = { personId: "ada", edition: "team" };
  expect(mayChange({ ownerId: "ada" }, who)).toBe(true);
  expect(mayChange({ ownerId: "grace" }, who)).toBe(false);
  expect(mayChange({ ownerId: null }, who)).toBe(false);
  expect(mayChange({ ownerId: null }, { ...who, edition: "personal" })).toBe(
    true,
  );
  // Not yet known: nothing is offered.
  expect(
    mayChange({ ownerId: "ada" }, { personId: undefined, edition: undefined }),
  ).toBe(false);
  expect(
    mayChange({ ownerId: null }, { personId: "ada", edition: undefined }),
  ).toBe(false);
});
