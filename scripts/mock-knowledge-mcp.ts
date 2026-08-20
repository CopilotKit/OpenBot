/**
 * A knowledge MCP server with nothing real behind it.
 *
 * Slice 1 puts a Bot in front of a stranger with no account, which means it must answer without
 * anybody having connected anything. This stands in for the customer's Notion: real MCP over HTTP,
 * fixed content, safe to point at the open internet.
 *
 * `@copilotkit/aimock` rather than a hand-rolled server, so what a Bot talks to here is the same
 * protocol implementation the tests talk to.
 */
import { MCPMock } from "@copilotkit/aimock/mcp";

const PORT = Number.parseInt(process.env.MOCK_KNOWLEDGE_PORT ?? "4300", 10);

const NOTES = [
  {
    title: "Expense policy",
    url: "https://notion.example/expense-policy",
    body: "Meals under $75 need no receipt. Anything above needs one, and anything above $500 needs your manager before you spend it.",
  },
  {
    title: "Onboarding checklist",
    url: "https://notion.example/onboarding",
    body: "Day one: laptop, SSO, and the team channel. Week one: shadow two customer calls. Month one: ship something small to production.",
  },
  {
    title: "Incident review: checkout outage",
    url: "https://notion.example/incident-checkout",
    body: "Checkout was down for 41 minutes. Cause was an expired certificate nobody owned. Action: certificates get an owner and an alert at 30 days.",
  },
];

const mock = new MCPMock({ port: PORT } as never);

mock.addTool({
  name: "search_notes",
  description:
    "Search the company's notes and return the matching ones with a link to each. Use this for any question about company policy, process or history.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "What to look for." },
    },
    required: ["query"],
  },
});

mock.onToolCall("search_notes", (args) => {
  const query = String((args as { query?: string })?.query ?? "").toLowerCase();
  const hits = NOTES.filter((note) =>
    `${note.title} ${note.body}`.toLowerCase().includes(query),
  );
  const found = hits.length > 0 ? hits : NOTES;
  return found
    .map(
      (note) =>
        `## ${note.title}\n\n${note.body}\n\n[Open the note](${note.url})`,
    )
    .join("\n\n---\n\n");
});

const url = await mock.start();
console.info(JSON.stringify({ type: "mock-knowledge-mcp", url }));
