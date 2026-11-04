import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { Tool } from "@ag-ui/core";
import { HttpAgent } from "@copilotkit/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient } from "@tanstack/react-query";
import { cleanup, renderHook } from "@testing-library/react";
import { of } from "rxjs";
import { agentQueryOptions } from "@/lib/agents/queries";
import { agentComponentsQueryOptions } from "@/lib/components/queries";
import {
  type BotFacts,
  factsFor,
  heldComponent,
  offerFor,
  offerItsOwnTools,
  useOfferedTo,
} from "@/lib/copilot/bot-offer";
import { computerToolsOffered } from "@/lib/copilot/computer-available";
import { myCapabilitiesQueryOptions } from "@/lib/enterprise/queries";
import { agentPluginsQueryOptions } from "@/lib/plugins/queries";
import { settleReactWork } from "./settle-react-work";

/**
 * What one run of a Bot is offered, and how its facts are read: the rules in `bot-offer.ts` against
 * the shapes the server answers with, and the middleware on a real AG-UI agent.
 */

const BOT = "crm-bot";
const originalFetch = globalThis.fetch;

beforeAll(() => GlobalRegistrator.register());
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

/** The server's answers for one Bot, as `components`, `agent`, `me` and `plugins` routes give them. */
function answering(
  answer: (path: string) => Response | Promise<Response>,
): string[] {
  const asked: string[] = [];
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0]) => {
      const path = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
        "http://127.0.0.1",
      ).pathname;
      asked.push(path);
      return answer(path);
    },
    { preconnect: () => undefined },
  );
  return asked;
}

const RECORD = { name: "showRecord", description: "Its published words." };
const PROFILE = { id: BOT, visibility: "public", canManage: true };

function ordinaryAnswer(path: string): Response {
  if (path === `/api/components/for-agent/${BOT}`)
    return Response.json({ components: [RECORD] });
  if (path === `/api/agents/${BOT}`) return Response.json({ agent: PROFILE });
  if (path === "/api/admin/enterprise/me")
    return Response.json({ capabilities: {}, enforced: false });
  if (path === `/api/plugins/for/${BOT}`)
    return Response.json({ skills: [], tools: [] });
  return Response.json({ error: "Not found" }, { status: 404 });
}

const tool = (name: string): Tool => ({
  name,
  description: "The built-in words.",
  parameters: { type: "object", properties: {} },
});

const facts = (overrides: Partial<BotFacts> = {}): BotFacts => ({
  components: new Map(),
  profile: PROFILE,
  capabilities: {},
  skills: new Set(),
  ...overrides,
});

/*
 * ONE FAILED READ MUST NOT PUT THE SCREEN IN AN ERROR STATE. The facts are read through the very
 * queries the screen observes, and reading them with `retry: false` errored the shared query on one
 * transient failure: the cards on screen then said the grant could not be checked.
 */
test("a transient failure reading a Bot's grants is retried as the screen's own read is, and leaves the query answered", async () => {
  let failures = 1;
  answering((path) => {
    if (path === `/api/components/for-agent/${BOT}` && failures > 0) {
      failures -= 1;
      return Response.json({ error: "Try again" }, { status: 503 });
    }
    return ordinaryAnswer(path);
  });
  const queries = new QueryClient({
    defaultOptions: { queries: { retry: 1, retryDelay: 5 } },
  });

  const bot = await factsFor(queries, BOT);

  expect(bot.components?.get("showRecord")).toBe(RECORD.description);
  expect(
    queries.getQueryState(agentComponentsQueryOptions(BOT).queryKey)?.status,
  ).toBe("success");
});

/*
 * A STEP DOES NOT WAIT ON THE NETWORK FOR WHAT IS ALREADY KNOWN. Facts older than a few seconds were
 * fetched again before every step, four of them, so one slow route held up every step of a turn.
 */
test("facts already read are served at once, and fetched again in the background", async () => {
  const asked = answering(() => new Promise<Response>(() => {}));
  const queries = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const long = { updatedAt: Date.now() - 60_000 };
  queries.setQueryData(
    agentComponentsQueryOptions(BOT).queryKey,
    [RECORD],
    long,
  );
  queries.setQueryData(agentQueryOptions(BOT).queryKey, PROFILE as never, long);
  queries.setQueryData(
    myCapabilitiesQueryOptions().queryKey,
    { capabilities: {}, enforced: false },
    long,
  );
  queries.setQueryData(
    agentPluginsQueryOptions(BOT).queryKey,
    { skills: [], tools: [] },
    long,
  );

  const bot = await Promise.race([
    factsFor(queries, BOT),
    new Promise<"still waiting">((resolve) =>
      setTimeout(() => resolve("still waiting"), 300),
    ),
  ]);

  expect(bot).not.toBe("still waiting");
  expect((bot as BotFacts).components?.get("showRecord")).toBe(
    RECORD.description,
  );
  // And the next step's facts are on their way.
  expect(asked).toContain(`/api/components/for-agent/${BOT}`);
});

/*
 * A BOT NOBODY COULD READ IS NOT HANDED A COMPUTER. With no profile, because the read failed or the
 * run names no Bot at all, every computer tool used to be offered, and a call with no Bot of its own
 * falls back to the Bot on screen.
 */
test("a Bot whose profile could not be read is offered no computer tools", () => {
  expect(
    computerToolsOffered({ profile: undefined, capabilities: {} }),
  ).toEqual({ browser: false, navigate: false, computer: false });
});

/*
 * ONE REGISTRANT LEAVING DOES NOT TAKE ANOTHER'S RULE. The gallery and the browser-authored
 * components register the same rule under component names; the second one's cleanup deleted the
 * rule they shared, and the component it named was then offered to every Bot.
 */
test("a rule two registrants declared stays while one of them is still mounted", () => {
  const fromTheGallery = renderHook(() => useOfferedTo(GALLERY_RULES));
  const fromTheSandbox = renderHook(() => useOfferedTo(SANDBOX_RULES));

  fromTheSandbox.unmount();

  // A Bot that does not hold the record is still not offered it.
  expect(offerFor([tool("showRecord")], facts())).toEqual([]);
  fromTheGallery.unmount();
});
const GALLERY_RULES = { showRecord: heldComponent };
const SANDBOX_RULES = { showRecord: heldComponent };

/*
 * A COPY OF AN AGENT IS NARROWED ONCE. `AbstractAgent.clone()` copies the middlewares, so a copy
 * that was given the offer again carried two, and every step was narrowed (and its facts read)
 * twice.
 */
test("a copy of an agent that already carries the offer is narrowed once a step", async () => {
  answering(ordinaryAnswer);
  const queries = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  let asked = 0;
  const counting = () => {
    asked += 1;
    return true;
  };
  const rules = { probe_tool: counting };
  const registered = renderHook(() => useOfferedTo(rules));

  const agent = new HttpAgent({ url: "http://127.0.0.1/none" });
  offerItsOwnTools(agent, BOT, queries);
  const copy = agent.clone();
  offerItsOwnTools(copy, BOT, queries);
  let offered: string[] = [];
  copy.run = (input) => {
    offered = input.tools.map((entry) => entry.name);
    return of(
      { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId },
      { type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId },
    ) as ReturnType<HttpAgent["run"]>;
  };

  await copy.runAgent({ tools: [tool("probe_tool")] });

  expect(offered).toEqual(["probe_tool"]);
  expect(asked).toBe(1);
  registered.unmount();
});
