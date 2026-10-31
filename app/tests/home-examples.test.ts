import { expect, test } from "bun:test";
import { homeExamples } from "@/lib/home-examples";

test("builds one prompt per Bot that has a role description", () => {
  const examples = homeExamples([
    {
      name: "Knowledge",
      roleDescription: "Answer questions from our documents",
    },
    { name: "No role", roleDescription: null },
    { name: "Blank role", roleDescription: "   " },
    { name: "Writer", roleDescription: "Draft release notes" },
  ]);
  expect(examples).toHaveLength(2);
  expect(examples[0]).toContain("Knowledge");
  expect(examples[0]).toContain("Answer questions from our documents");
  expect(examples[1]).toContain("Writer");
});

test("returns no prompts for no Bots", () => {
  expect(homeExamples([])).toEqual([]);
});

test("returns at most five prompts", () => {
  const agents = Array.from({ length: 8 }, (_, index) => ({
    name: `Bot ${index}`,
    roleDescription: `Role ${index}`,
  }));
  expect(homeExamples(agents)).toHaveLength(5);
});

test("a long role becomes its first sentence, short enough for one line", () => {
  const [example] = homeExamples([
    {
      name: "Meeting Follow-ups",
      roleDescription:
        "Read one set of meeting notes and produce the follow-ups that are in them. A follow-up is something a named person said they would do.",
    },
  ]);
  expect(example).toBe(
    "Ask Meeting Follow-ups: Read one set of meeting notes and produce the follow-ups that are in them.",
  );
});

test("a first sentence over 80 characters is cut at a word", () => {
  const [example] = homeExamples([
    {
      name: "Research Desk",
      roleDescription:
        "Write a brief that answers the question, cites every source it used, and names what it could not find anywhere.",
    },
  ]);
  expect(example).toBe(
    "Ask Research Desk: Write a brief that answers the question, cites every source it used, and names…",
  );
});
