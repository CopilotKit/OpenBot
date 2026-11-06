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

test("reads front matter written with CRLF line endings", () => {
  expect(
    skillNameOf(
      skill("---\r\nname: Refund triage\r\ndescription: x\r\n---\r\n"),
    ),
  ).toBe("Refund triage");
});

test("reads front matter behind a byte order mark", () => {
  expect(skillNameOf(skill("\uFEFF---\nname: Refund triage\n---\n"))).toBe(
    "Refund triage",
  );
  expect(
    skillNameOf(skill("\uFEFF---\r\nname: Refund triage\r\n---\r\n")),
  ).toBe("Refund triage");
});

test("removes single quotes around the name", () => {
  expect(skillNameOf(skill("---\nname: 'Refund triage'\n---\n"))).toBe(
    "Refund triage",
  );
});

test("finds the name when it is not the first key", () => {
  expect(
    skillNameOf(skill("---\ndescription: x\nname: Refund triage\n---\n")),
  ).toBe("Refund triage");
});

test("gives null for an empty name", () => {
  expect(skillNameOf(skill("---\nname:\n---\n"))).toBeNull();
  expect(skillNameOf(skill('---\nname: ""\n---\n'))).toBeNull();
  expect(skillNameOf(skill("---\nname:   \ndescription: x\n---\n"))).toBeNull();
});
