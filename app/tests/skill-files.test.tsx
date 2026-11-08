import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { SkillFiles, skillBody } from "@/components/learning/skill-files";

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());
afterEach(cleanup);

const skill =
  "---\nname: refunds\ndescription: Issue a refund\n---\n\nCheck the order first.\n";

test("skillBody drops the front matter", () => {
  expect(skillBody(skill)).toBe("Check the order first.");
});

test("shows the SKILL.md body and not its front matter", async () => {
  const { findByText, queryByText, getByText } = render(
    <SkillFiles files={[{ path: "SKILL.md", text: skill }]} />,
  );
  expect(await findByText("Check the order first.")).toBeTruthy();
  expect(queryByText(/description: Issue a refund/)).toBeNull();
  expect(getByText("SKILL.md")).toBeTruthy();
});

test("lists another file by path", () => {
  const { getByText } = render(
    <SkillFiles
      files={[
        { path: "SKILL.md", text: skill },
        { path: "steps.md", text: "one two" },
      ]}
    />,
  );
  expect(getByText("steps.md")).toBeTruthy();
  expect(getByText("one two").tagName).toBe("PRE");
});

test("a binary file shows its path and no pre", () => {
  const { getByText, container } = render(
    <SkillFiles
      files={[
        { path: "SKILL.md", text: skill },
        { path: "logo.png", text: null },
      ]}
    />,
  );
  expect(getByText("logo.png")).toBeTruthy();
  expect(container.querySelector("pre")).toBeNull();
});

test("front matter with Windows line endings is dropped too", () => {
  const crlf = skill.replace(/\n/g, "\r\n");
  expect(skillBody(crlf)).toBe("Check the order first.");
});

test("a SKILL.md that is binary shows its path", () => {
  const { getByText, container } = render(
    <SkillFiles files={[{ path: "SKILL.md", text: null }]} />,
  );
  expect(getByText("SKILL.md")).toBeTruthy();
  expect(container.querySelector("pre")).toBeNull();
});
