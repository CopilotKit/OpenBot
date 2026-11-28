import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * docs/agent-frameworks.md sends a developer to the LangGraph and Mastra receivers that take a Bot's
 * role and tool guidance as run context. It points at what was published: the released packages, and
 * their guides at the AG-UI commit that released them, never a commit that only ever sat on a pull
 * request. And it says what OpenBot does with a Mastra server's declaration, which it reads.
 */

const GUIDE = readFileSync(
  join(import.meta.dir, "../docs/agent-frameworks.md"),
  "utf8",
);

/** ag-ui-protocol/ag-ui `main`, the merge that released ag-ui-langgraph 0.1.0 and @ag-ui/mastra 2.1.0. */
const RELEASE_COMMIT = "96caee88f5e441d4901d626b5d199a3e9de7c667";

test("the receivers' guides are linked at the commit that released them", () => {
  const commits = [
    ...GUIDE.matchAll(
      /github\.com\/ag-ui-protocol\/ag-ui\/blob\/([^/\s)]+)\//g,
    ),
  ].map(([, commit]) => commit);
  expect(commits.length).toBeGreaterThan(0);
  expect([...new Set(commits)]).toEqual([RELEASE_COMMIT]);
});

test("the guide names the published receivers", () => {
  expect(GUIDE).toContain("https://pypi.org/project/ag-ui-langgraph/0.1.0/");
  expect(GUIDE).toContain(
    "https://www.npmjs.com/package/@ag-ui/mastra/v/2.1.0",
  );
});

test("the guide says OpenBot reads a Mastra server's declaration", () => {
  expect(GUIDE).not.toMatch(/doesn't read a Mastra server's declaration/);
  expect(GUIDE).toContain("`GET <address>/<agent id>/capabilities`");
});
