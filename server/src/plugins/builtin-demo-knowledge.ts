import type { McpCallResult, McpTool } from "./mcp";
import type { KnowledgeDocumentStore } from "../documents/store";

/**
 * Knowledge Agent's search tool. Reads Postgres via {@link useKnowledgeDocuments};
 * until that is wired, every call refuses rather than inventing demo text.
 */
let documentStore: KnowledgeDocumentStore | null = null;

export function useKnowledgeDocuments(
  store: KnowledgeDocumentStore | null,
): void {
  documentStore = store;
}

const TOOLS: readonly McpTool[] = Object.freeze([
  {
    name: "search_knowledge",
    description:
      "Search approved company knowledge documents. Use this for company policy, engineering practice, and product questions. Cite the returned title in the answer.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The policy, practice, or product information to find.",
        },
      },
      required: ["query"],
    },
  },
]);

export const listNeedsCredential = false;

export async function listTools(): Promise<McpTool[]> {
  return TOOLS.map((tool) => ({ ...tool }));
}

export async function callTool(
  _connection: { url: string },
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpCallResult> {
  if (toolName !== "search_knowledge") {
    return {
      text: `${toolName} is not available in AgentForce knowledge.`,
      isError: true,
      truncated: false,
    };
  }

  if (!documentStore) {
    return {
      text: "Company knowledge is not available on this deployment.",
      isError: true,
      truncated: false,
    };
  }

  const query =
    typeof args.query === "string" ? args.query.trim().toLowerCase() : "";
  if (!query) {
    return {
      text: "Say what company policy, engineering practice, or product information to search for.",
      isError: true,
      truncated: false,
    };
  }

  const selected = await documentStore.search(query);
  if (selected.length === 0) {
    return {
      text: "No company documents matched that search.",
      isError: false,
      truncated: false,
    };
  }

  const text = selected
    .map(
      (document) =>
        `## ${document.title}\n\nCategory: ${document.category}\n\n${document.body}\n\n[Source: ${document.title}](/documents/${document.id})`,
    )
    .join("\n\n---\n\n");

  return { text, isError: false, truncated: false };
}
