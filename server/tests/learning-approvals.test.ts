import { expect, test } from "bun:test";
import { skillNameOf } from "../src/learning/approvals";

const skill = (content: string) => [{ path: "SKILL.md", content }];

test("takes the name from the SKILL.md front matter", () => {
  expect(
    skillNameOf(skill("---\nname: Refund triage\ndescription: x\n---\n\nBody")),
  ).toBe("Refund triage");
});

test("removes quotes around the name", () => {
  expect(skillNameOf(skill('---\nname: "Refund triage"\n---\n'))).toBe(
    "Refund triage",
  );
});

test("gives null when SKILL.md has no front matter", () => {
  expect(skillNameOf(skill("# Refund triage\n"))).toBeNull();
});

test("gives null when the name is not a valid skill name", () => {
  expect(skillNameOf(skill("---\nname: a/b\n---\n"))).toBeNull();
});

test("gives null when there is no SKILL.md", () => {
  expect(
    skillNameOf([{ path: "notes/SKILL.md", content: "---\nname: A\n---\n" }]),
  ).toBeNull();
});
