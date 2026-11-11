import { expect, test } from "bun:test";
import {
  HARNESSES,
  starterSubtitle,
  WEB_HARNESSES,
  withCurrentFrameworkNames,
} from "./harnesses";

test("carries every row the desktop picker offers, in its order", () => {
  expect(HARNESSES.map((h) => h.id)).toEqual([
    "crewai",
    "llamaindex",
    "agno",
    "langgraph",
    "google-adk",
    "antigravity",
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

test("leads the web list with the partners people look for, keeping the rest in order", () => {
  expect(WEB_HARNESSES.map((h) => h.id)).toEqual([
    "claude-agent-sdk",
    "google-adk",
    "antigravity",
    "langgraph",
    "crewai",
    "llamaindex",
    "agno",
    "pydantic-ai",
    "microsoft-agent-framework",
    "strands",
    "ag2",
    "langroid",
    "byo-url",
  ]);
});

test("the brands with no usable mark carry none", () => {
  const unmarked = HARNESSES.filter((h) => h.mark === null)
    .map((h) => h.id)
    .sort();
  expect(unmarked).toEqual(["byo-url"]);
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

test("CrewAI uses its expected image, health endpoint and port", () => {
  const crewai = HARNESSES.find((h) => h.id === "crewai");
  expect(crewai?.image).toBe("agent-crewai");
  expect(crewai?.healthPath).toBe("/health");
  expect(crewai?.port).toBe(4202);
});

/*
 * Antigravity only ever runs on Gemini: its README says the harness requires a Gemini API key
 * wherever `base_url` points. `any-provider` would let a deployment holding only an OpenAI key
 * install it and get a Bot that cannot answer — the shape of failure `webCreate: false` exists to
 * stop for Mastra.
 */
test("marks Antigravity as needing Google's key rather than any provider's", () => {
  const antigravity = HARNESSES.find((h) => h.id === "antigravity");
  expect(antigravity?.credential).toBe("google");
  expect(antigravity?.name).toBe("Google Antigravity");
  expect(antigravity?.image).toBe("agent-antigravity");
  expect(antigravity?.port).toBe(4214);
  expect(antigravity?.mark).toBe("antigravity");
  expect(antigravity?.webCreate).toBe(true);
});

test("gives every row a credential the type actually names", () => {
  const known = ["any-provider", "anthropic", "google", "their-endpoint"];
  for (const harness of HARNESSES) {
    expect(known).toContain(harness.credential);
  }
});

/**
 * The Personal Assistant on an install seeded before LangChain was renamed still read "Everyday life.
 * Powered by LangChain (LangGraph)." on its profile, because a starter's subtitle is written once
 * and a Bot whose connection the person saved is never moved again. Its seed now reads the way the
 * starter is seeded today; other subtitles OpenBot wrote read by the current name; the person's own
 * words are not touched.
 */
test("reads a subtitle OpenBot wrote under earlier names the way it writes it now", () => {
  const langchain =
    "Everyday life agent. (powered by a LangChain agent; you can bring your own agent from any stack.)";
  expect(starterSubtitle("LangChain")).toBe(langchain);
  expect(starterSubtitle("AWS Strands")).toBe(
    "Everyday life agent. (powered by an AWS Strands agent; you can bring your own agent from any stack.)",
  );
  for (const seeded of [
    "Everyday life. Powered by LangChain (LangGraph).",
    "Everyday life. Powered by LangGraph.",
    "Everyday life. Powered by LangChain.",
  ]) {
    expect(withCurrentFrameworkNames(seeded)).toBe(langchain);
  }
  expect(
    withCurrentFrameworkNames("Everyday life. Powered by Claude Agent SDK."),
  ).toBe(starterSubtitle("Claude Agent SDK"));
  expect(withCurrentFrameworkNames("Powered by LangChain (LangGraph)")).toBe(
    "Powered by LangChain",
  );
  expect(withCurrentFrameworkNames("Errands. Powered by LangGraph.")).toBe(
    "Errands. Powered by LangChain.",
  );
  // Already current, a Bot that runs here, or the person's own words: left as they are.
  for (const title of [
    langchain,
    "Everyday life. Powered by OpenBot.",
    "Everyday life.",
    "Errands. Powered by LangChain.",
    "I like LangGraph for research.",
    "",
  ]) {
    expect(withCurrentFrameworkNames(title)).toBe(title);
  }
});
