import { z } from "zod";
import { type AuditStore, recordAuditEvent } from "../audit";
import type { GrantedTool } from "../plugins/tools";
import type { KnowledgeAsker, KnowledgeSearch } from "./search";

/**
 * The company's own documents, as something a Bot can call.
 *
 * WHY IT IS A TOOL rather than retrieval stapled to the prompt. A Bot that is handed passages before
 * it speaks is answering from whatever the retriever guessed the question was. A Bot that calls this
 * asks its own question, and the call is a thing the trail can record, the model can be refused, and
 * a person can read back. It reaches the model the same way an MCP tool does — through
 * `builtInAgentConfiguration`'s `tools`, executed on the server, never registered by a browser.
 *
 * WHAT MAKES IT SAFE IS THE QUERY, not this file. Every row is filtered against the asker's own
 * principals in SQL before it leaves PostgreSQL (see search.ts). So this tool cannot return a
 * document the person asking could not have opened themselves, whichever Bot is holding it. That is
 * the reason it is offered without a per-Bot grant of its own: the grant would refine who may ask,
 * and the ACL already decides what any answer may contain.
 *
 * SAYING NOTHING IS AN ANSWER. An empty result returns a sentence saying so rather than an empty
 * string, because a model handed nothing fills the gap from training and cites a document that does
 * not exist. The Knowledge coworker's own prompt already tells it to say when nothing is connected;
 * this is the same instruction arriving as data.
 */

/** Named for the model reading it. A Bot picks a tool by what the name and description promise. */
export const KNOWLEDGE_TOOL_NAME = "search_company_knowledge";

const NOTHING_FOUND =
  "No authorized document matched that. Say so plainly rather than answering from memory, and do not cite anything.";

const parameters = z.object({
  query: z
    .string()
    .describe("What to look for, in the words a person would use."),
});

export function knowledgeSearchTool(options: {
  search: KnowledgeSearch;
  auditStore: AuditStore;
  asker: KnowledgeAsker;
  botId: string;
}): GrantedTool {
  const { search, auditStore, asker, botId } = options;

  return {
    name: KNOWLEDGE_TOOL_NAME,
    description:
      "Search the company's connected documents and return the matching ones with a link to each. " +
      "Use this for any question about company policy, process, or history. Only documents the " +
      "person asking is allowed to read are returned.",
    parameters,
    execute: async (args: unknown) => {
      const parsed = parameters.safeParse(args);
      /*
       * A malformed call is answered, not thrown. The model is mid-run and an exception here ends the
       * turn with nothing said; the same reasoning as the refusal path in plugins/tools.ts.
       */
      if (!parsed.success) {
        return "That search needs a query: a short phrase describing what to look for.";
      }

      const citations = await search.search({
        asker,
        query: parsed.data.query,
      });

      /*
       * The row is written after the search rather than before it, and this is the one place in the
       * deployment where that is the right way round. Nothing is being acted on: no document changes,
       * nothing leaves the deployment, and the interesting fact is what came back rather than what was
       * attempted. `knowledge.searched` was already declared in audit.ts for exactly this.
       *
       * The query text is recorded, the way a shell command's text is. What is not recorded is any
       * passage: `content` is on the redaction list in audit.ts, and a snippet is the document's text
       * under another name, so the row names the documents and never quotes them.
       */
      await recordAuditEvent(auditStore, {
        eventType: "knowledge.searched",
        targetType: "knowledge",
        targetId: botId,
        actorUserId: asker.userId,
        payload: {
          bot: botId,
          query: parsed.data.query,
          matched: citations.length,
          documents: citations.map((citation) => citation.documentId),
        },
      });

      if (citations.length === 0) return NOTHING_FOUND;

      /*
       * Formatted for a model that has to cite it, so each document is one block with its link beside
       * its passage. A JSON blob would be read as data to summarise; this reads as sources to quote.
       */
      return citations
        .map(
          (citation) =>
            `${citation.title}\n${citation.url}\n${citation.snippet}`,
        )
        .join("\n\n");
    },
  };
}
