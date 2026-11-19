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

export const NOTES = [
  {
    title: "Employee Handbook — Annual Leave",
    url: "https://demo.agentforce.local/knowledge/employee-handbook",
    body: "For this synthetic AgentForce demo, full-time employees receive 20 working days of annual leave each calendar year. Leave should be requested at least five working days in advance and approved by the employee's manager. Up to five unused days may be carried into the next calendar year and must be used by March 31.",
  },
  {
    title: "Engineering Guidelines",
    url: "https://demo.agentforce.local/knowledge/engineering-guidelines",
    body: "For this synthetic AgentForce demo, all production changes require one peer review. Pull requests must explain the customer impact, include test evidence, and link the relevant issue. Security-sensitive changes require a second reviewer from the platform team.",
  },
  {
    title: "Product Overview — Plug 2.0",
    url: "https://demo.agentforce.local/knowledge/product-overview",
    body: "For this synthetic AgentForce demo, Plug 2.0 is Descasio's workflow automation platform for digitizing approvals, requisitions, and operational processes. Current priorities are the Process Builder experience, reusable workflow templates, and clearer audit history.",
  },
];

const mock = new MCPMock({ port: PORT } as never);

mock.addTool({
  name: "search_notes",
  description:
    "Search Descasio's synthetic demo knowledge and return matching documents with a citation link. Use this for questions about company policy, engineering practice, or Plug 2.0.",
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
