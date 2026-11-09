import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { ServerToolLine } from "@/components/channels/chat-transcript";
import {
  AuditPage,
  withoutOpenBotWorking,
} from "@/components/manage/audit-page";
import { agentKeys } from "@/lib/agents/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import { pluginKeys } from "@/lib/plugins/queries";
import { seedAuditPage } from "./seed-audit-page";
import { settleReactWork } from "./settle-react-work";

/*
 * FOUND ON WINDOWS (personal edition, 0.3.4 release candidates), each a row or a step a person read:
 * - Settings > Activity's older rows said "Register an OAuth client".
 * - "Give a Bot a skill" named the skill by its slug ("Skill creator", "Bot creator", "Research
 *   public web"), while the skills' own titles are "Write a skill", "Make a coworker" and "Research
 *   the public web".
 * - A Bot asked for Notion, the person pressed Connect, and the row read "Approve a request for an
 *   app, Notion, Allowed" beside "Started by a person". Nobody approved anything: the personal
 *   edition lets every Bot use every app the person turns on.
 * - An opened "Looked for a tool" listed `mcp__composio-gmail__GMAIL_...`.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(() => cleanup());
afterAll(async () => {
  await settleReactWork();
  await GlobalRegistrator.unregister();
});

const BOT = "tide-pal";

function row(
  id: string,
  minute: number,
  fields: {
    eventType: string;
    targetType: string;
    targetId: string;
    initiatorKind?: string;
    payload: Record<string, unknown>;
  },
) {
  return {
    id,
    actorUserId: "dev",
    initiatorId: null,
    initiatorKind: "person",
    ...fields,
    createdAt: `2026-11-08T17:${String(minute).padStart(2, "0")}:00Z`,
  };
}

const skillGiven = (slug: string, minute: number) =>
  row(`skill-${slug}`, minute, {
    eventType: "configuration.changed",
    targetType: "skill",
    targetId: slug,
    payload: {
      actor: "dev",
      change: "plugin_granted",
      kind: "skill",
      ref: slug,
      bot: BOT,
    },
  });

/** Newest first, as the server answers. Each row as the server stores it. */
const ROWS = [
  row("connect", 59, {
    eventType: "app_access.approved",
    targetType: "mcp_server",
    targetId: "notion",
    payload: {
      request: "request-1",
      app: "notion",
      bot: BOT,
      kind: "enable",
      enabled: true,
      granted: 0,
      direct: true,
    },
  }),
  skillGiven("skill-creator", 58),
  skillGiven("bot-creator", 57),
  skillGiven("research-public-web", 56),
  row("sign-in", 55, {
    eventType: "mcp.oauth_client_registered",
    targetType: "mcp_server",
    targetId: "notion",
    payload: {
      actor: "dev",
      server: "notion",
      clientId: "client-1",
      replaced: false,
    },
  }),
];

/** The skills as the Skills page lists them, each with its own title. */
const SKILLS = [
  { slug: "skill-creator", title: "Write a skill" },
  { slug: "bot-creator", title: "Make a coworker" },
  { slug: "research-public-web", title: "Research the public web" },
].map(({ slug, title }) => ({
  id: slug,
  slug,
  title,
  ownerUserId: "dev",
  summary: "",
  instructions: "",
  origin: "bundled",
  installedBy: null,
  grantedTo: [BOT],
  tools: [],
}));

async function renderAs(edition: "team" | "personal") {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  queryClient.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    selfHostBanner: false,
    localEvaluation: edition === "personal",
    edition,
  });
  seedAuditPage(
    queryClient,
    edition === "personal" ? withoutOpenBotWorking("") : "",
    { events: ROWS },
  );
  queryClient.setQueryData(pluginKeys.page(), {
    catalogue: [],
    servers: [],
    skills: SKILLS,
  });
  queryClient.setQueryData(agentKeys.list(false), [
    { id: BOT, name: "Tide Pal" },
  ]);
  queryClient.setQueryData(agentKeys.list(true), []);
  const router = createRouter({
    routeTree: createRootRoute({ component: () => <AuditPage /> }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await view.findByText("Decision");
  return view;
}

/** Each row's What, the line under it, who started it, and its Decision, as drawn. */
function drawn(container: HTMLElement) {
  return [...container.querySelectorAll("tbody tr")].map((tr) => {
    const what = [
      ...(tr.querySelector("[data-column=what]")?.children ?? []),
    ].map((line) => line.textContent);
    const who = [...(tr.querySelector("[data-column=bot]")?.children ?? [])];
    return {
      what: what[0],
      on: what[1],
      startedBy: who[1]?.textContent ?? "",
      decision: tr.querySelector("[data-column=decision] span")?.textContent,
    };
  });
}

test("Activity names a skill by its title, an app's sign-in in words, and an app nobody had to approve", async () => {
  const view = await renderAs("personal");
  expect(drawn(view.container)).toEqual([
    {
      what: "Let a Bot use an app",
      on: "Notion",
      startedBy: "Started by a person",
      decision: "Allowed automatically",
    },
    {
      what: "Give a Bot a skill",
      on: "Write a skill",
      startedBy: "Started by a person",
      decision: "Configuration changed",
    },
    {
      what: "Give a Bot a skill",
      on: "Make a coworker",
      startedBy: "Started by a person",
      decision: "Configuration changed",
    },
    {
      what: "Give a Bot a skill",
      on: "Research the public web",
      startedBy: "Started by a person",
      decision: "Configuration changed",
    },
    {
      what: "Set up an app's sign-in",
      on: "Notion",
      startedBy: "Started by a person",
      decision: "Allowed",
    },
  ]);
  const table = view.container.querySelector("tbody")?.textContent ?? "";
  for (const jargon of [
    "OAuth",
    "Approve a request",
    "Skill creator",
    "Bot creator",
    "Research public web",
  ])
    expect(table).not.toContain(jargon);
});

test("Admin keeps an admin's one-press approval as an approval", async () => {
  const view = await renderAs("team");
  expect(drawn(view.container)[0]).toMatchObject({
    what: "Approve a request for an app",
    on: "notion",
    decision: "Allowed",
  });
});

/** What a tool search answers the model, as `server/src/agents/tool-search.ts` writes it. */
const SEARCH_ANSWER = [
  "Tools found: mcp__composio-gmail__GMAIL_SEND_EMAIL, mcp__composio-gmail__GMAIL_FETCH_MESSAGE_BY_THREAD_ID",
  'You can call them from your next step, for "send an email". What each one does, in its app\'s words:',
  "<untrusted>- mcp__composio-gmail__GMAIL_SEND_EMAIL: Sends an email.</untrusted>",
].join("\n");

test("an opened tool search names the tools it found in words, never by their ids", async () => {
  const view = render(
    <QueryClientProvider client={new QueryClient()}>
      <ServerToolLine
        args={JSON.stringify({ query: "send an email" })}
        name="search_tools"
        result={SEARCH_ANSWER}
      />
    </QueryClientProvider>,
  );
  fireEvent.click(await view.findByText("Looked for a tool"));
  await view.findByText("Send email on Gmail");
  expect(view.getByText("Fetch thread messages on Gmail")).toBeTruthy();
  const text = view.container.textContent ?? "";
  for (const id of ["mcp__", "GMAIL_", "composio", "Tools found"])
    expect(text).not.toContain(id);
});
