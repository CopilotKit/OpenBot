import { afterAll, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import {
  answerListBotSkills,
  answerListBots,
  answerReadBot,
} from "@/lib/agents/answers";

/**
 * What the three reading tools say, asked cold.
 *
 * COLD IS THE WHOLE POINT. The regression these guard against is not a wrong sentence, it is a right
 * sentence about the wrong state: handlers that closed over a `useQuery` result answered
 * "No skills exist here yet" while nine existed, because the model called the tool in the first
 * second of a run and the query had not come back. The Bot then told the person that as a fact about
 * their deployment.
 *
 * So every test here uses a query client nothing has rendered against and nothing has warmed, which
 * is exactly the state that produced the bug. A handler that reads a snapshot instead of fetching
 * fails these; one that fetches passes.
 *
 * The transport is stubbed at `fetch` and restored afterwards. No module mocks: `mock.module` in bun
 * is process-wide and does not come back, so a file that mocked `@/lib/client` here would silently
 * change what every other test file in the suite imports.
 */

const AGENTS = [
  {
    id: "general-assistant",
    name: "General Assistant",
    title: "Everyday Work",
    roleDescription: "Help with everyday work.",
    avatarSeed: "general-assistant",
    visibility: "public",
    endpoint: null,
    hasAuth: false,
    hasCallbackToken: false,
    hidden: false,
    systemOwned: true,
    canManage: true,
    mine: false,
  },
  {
    id: "agent_1",
    name: "Renewal Desk",
    title: "Accounts Receivable",
    roleDescription: "Chase overdue invoices. Never invent a date.",
    avatarSeed: "renewal-desk",
    visibility: "private",
    endpoint: "https://renewals.example.com/ag-ui",
    hasAuth: true,
    hasCallbackToken: false,
    hidden: false,
    systemOwned: false,
    canManage: true,
    mine: true,
  },
];

const SKILLS = [
  {
    id: "skill_1",
    slug: "find-a-document",
    ownerUserId: null,
    title: "Find a document",
    summary: "Search the connected sources and read what it says.",
    instructions: "Search first, then read the file you found.",
    origin: "package",
    installedBy: null,
    grantedTo: [],
    tools: ["google-drive/search_files"],
  },
];

const realFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
});

/** How many times the transport was reached, so "it fetched" is asserted rather than assumed. */
let calls: string[] = [];

globalThis.fetch = (async (input: RequestInfo | URL) => {
  const path = typeof input === "string" ? input : input.toString();
  calls.push(path);
  if (path.startsWith("/api/agents")) {
    return Response.json({ agents: AGENTS });
  }
  if (path === "/api/plugins") {
    return Response.json({
      catalogue: [],
      botsMayCallBack: false,
      servers: [],
      skills: SKILLS,
      redirectUri: "",
    });
  }
  return Response.json({ error: "not found" }, { status: 404 });
}) as typeof fetch;

/** A client nothing has rendered against, which is the state a run's first tool call happens in. */
function coldClient(): QueryClient {
  calls = [];
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

test("the roster is fetched when asked, not read off a render", async () => {
  const answer = await answerListBots(coldClient());

  expect(calls.some((path) => path.startsWith("/api/agents"))).toBe(true);
  expect(answer).toContain("2 coworkers already exist here");
  expect(answer).toContain("General Assistant — Everyday Work");
  // Whose it is and where it runs, which is what stops a duplicate being proposed.
  expect(answer).toContain("the deployment's");
  expect(answer).toContain("runs at its own address");
  expect(answer).toContain("Renewal Desk");
  // Role descriptions are deliberately not in the list: a dozen of them is most of a run.
  expect(answer).not.toContain("Never invent a date");
});

test("the skills are fetched when asked, so an unloaded list never reads as an empty one", async () => {
  const answer = await answerListBotSkills(coldClient());

  expect(calls).toContain("/api/plugins");
  expect(answer).toContain("/find-a-document — Find a document");
  // The sentence that was wrongly given to a person about a deployment holding nine skills.
  expect(answer).not.toContain("No skills exist here yet");
  // The line that stops the interview implying a skill brings capability with it.
  expect(answer).toContain("A skill is an instruction, not a capability");
});

test("one coworker comes back in full, including what it runs on", async () => {
  const answer = await answerReadBot(coldClient(), "renewal desk");

  expect(answer).toContain("Renewal Desk — Accounts Receivable (yours)");
  expect(answer).toContain("Chase overdue invoices. Never invent a date.");
  expect(answer).toContain("Runs at its own address");
});

test("a coworker that is not here is named rather than guessed at", async () => {
  const answer = await answerReadBot(coldClient(), "Nobody");

  expect(answer).toContain("There is no coworker called Nobody");
  expect(answer).toContain("Call list_bots");
});

/**
 * An empty deployment says it is empty, which is only safe because the answer above is fetched.
 *
 * The two sentences are opposites and the tool has to be able to give both; what must never happen
 * is the empty one being given about a deployment that simply had not answered yet.
 */
test("a genuinely empty deployment is described as empty", async () => {
  const client = coldClient();
  const previous = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = typeof input === "string" ? input : input.toString();
    calls.push(path);
    if (path.startsWith("/api/agents")) return Response.json({ agents: [] });
    return Response.json({
      catalogue: [],
      botsMayCallBack: false,
      servers: [],
      skills: [],
      redirectUri: "",
    });
  }) as typeof fetch;

  expect(await answerListBots(client)).toContain("No coworkers exist here yet");
  expect(await answerListBotSkills(client)).toContain(
    "No skills exist here yet",
  );

  globalThis.fetch = previous;
});
