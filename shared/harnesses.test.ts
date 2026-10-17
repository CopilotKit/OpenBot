import { expect, test } from "bun:test";
import { HARNESSES } from "./harnesses";

test("carries every row the desktop picker offers, in its order", () => {
  expect(HARNESSES.map((h) => h.id)).toEqual([
    "crewai",
    "llamaindex",
    "agno",
    "langgraph",
    "google-adk",
    "pydantic-ai",
    "microsoft-agent-framework",
    "claude-agent-sdk",
    "strands",
    "ag2",
    "langroid",
    "mastra",
    "byo-url",
  ]);
});

test("the brands with no usable mark carry none", () => {
  const unmarked = HARNESSES.filter((h) => h.mark === null)
    .map((h) => h.id)
    .sort();
  expect(unmarked).toEqual(["ag2", "agno", "byo-url", "langroid"]);
});

/*
 * Mastra is the one row a plain AG-UI endpoint cannot stand in for: the server dials it through the
 * `@ag-ui/mastra` bridge as `remote_mastra` and needs a roster id, neither of which the web create
 * API can send. Offered there it would make a Bot that answers nothing.
 */
test("marks Mastra as something the web dialog must not offer", () => {
  const notOfferable = HARNESSES.filter((h) => !h.webCreate).map((h) => h.id);
  expect(notOfferable).toEqual(["mastra"]);
});

test("gives a web-specific summary only where the installer's is false here", () => {
  const rewritten = HARNESSES.filter((h) => h.webSummary !== null).map(
    (h) => h.id,
  );
  expect(rewritten.sort()).toEqual(["byo-url", "claude-agent-sdk"]);
});

/*
 * The web app and the desktop both resolve a mark by globbing this directory, and a glob that
 * matches nothing fails silently: every row simply shows its name, which is also what a brand with
 * no mark legitimately looks like. Only this assertion tells the two apart.
 */
test("every named mark is vendored where both apps look for it", async () => {
  for (const harness of HARNESSES) {
    if (harness.mark === null) continue;
    const file = Bun.file(`${import.meta.dir}/marks/${harness.mark}.svg`);
    expect(await file.exists()).toBe(true);
  }
});

test("every row an image publishes names the directory it is built from", () => {
  const crewai = HARNESSES.find((h) => h.id === "crewai");
  expect(crewai?.image).toBe("agent-crewai");
  expect(crewai?.healthPath).toBe("/health");
  expect(crewai?.port).toBe(4202);
});
