import { describe, expect, test } from "bun:test";
import type { AuditEventInput, AuditStore } from "../src/audit";
import type {
  KnowledgeCitation,
  KnowledgeSearch,
} from "../src/knowledge/search";
import { knowledgeSearchTool } from "../src/knowledge/tool";

/**
 * What the model is handed, and what the trail is left.
 *
 * The query itself is a property of PostgreSQL and is asserted against a real database in
 * knowledge-search.integration.test.ts. Everything here is a property of this file: that an empty
 * result becomes a sentence rather than an empty string, that a row is written either way, and that
 * no passage reaches the row.
 */

const asker = { userId: "u_1", groups: ["finance"] };

function recorder() {
  const written: AuditEventInput[] = [];
  const auditStore: AuditStore = {
    insert: async (event) => {
      written.push(event);
    },
  };
  return { written, auditStore };
}

function searchReturning(citations: KnowledgeCitation[]): {
  search: KnowledgeSearch;
  asked: { query: string; userId: string }[];
} {
  const asked: { query: string; userId: string }[] = [];
  return {
    asked,
    search: {
      anyDocuments: async () => true,
      search: async ({ query, asker: who }) => {
        asked.push({ query, userId: who.userId });
        return citations;
      },
    },
  };
}

const oneCitation: KnowledgeCitation[] = [
  {
    documentId: "d_1",
    title: "Expense policy",
    url: "https://notion.example/expense-policy",
    snippet: "Meals under $75 need no <b>receipt</b>.",
  },
];

describe("the knowledge tool", () => {
  test("hands back each document with its link and its passage", async () => {
    const { search } = searchReturning(oneCitation);
    const tool = knowledgeSearchTool({
      search,
      auditStore: recorder().auditStore,
      asker,
      botId: "knowledge",
    });

    const answer = await tool.execute({ query: "receipts" });

    expect(answer).toContain("Expense policy");
    // The link, because a citation the person cannot open is not a citation.
    expect(answer).toContain("https://notion.example/expense-policy");
    expect(answer).toContain("receipt");
  });

  test("says nothing was found rather than returning an empty string", async () => {
    // A model handed "" fills the gap from training and cites a document that does not exist. This is
    // the same instruction the Knowledge coworker's prompt carries, arriving as data.
    const { search } = searchReturning([]);
    const tool = knowledgeSearchTool({
      search,
      auditStore: recorder().auditStore,
      asker,
      botId: "knowledge",
    });

    const answer = await tool.execute({ query: "something nobody wrote down" });

    expect(answer).not.toBe("");
    expect(answer.toLowerCase()).toContain("no authorized document");
    expect(answer.toLowerCase()).toContain("do not cite");
  });

  test("asks on behalf of the person, not the Bot", async () => {
    // The whole boundary. If this ever passed a service identity the ACL filter would be filtering
    // against the wrong principals and would still look like it worked.
    const { search, asked } = searchReturning(oneCitation);
    const tool = knowledgeSearchTool({
      search,
      auditStore: recorder().auditStore,
      asker,
      botId: "knowledge",
    });

    await tool.execute({ query: "receipts" });

    expect(asked).toHaveLength(1);
    expect(asked[0]?.userId).toBe("u_1");
  });

  test("writes a row naming the documents and never quoting them", async () => {
    const { search } = searchReturning(oneCitation);
    const { written, auditStore } = recorder();
    const tool = knowledgeSearchTool({
      search,
      auditStore,
      asker,
      botId: "knowledge",
    });

    await tool.execute({ query: "receipts" });

    expect(written).toHaveLength(1);
    const row = written[0];
    expect(row?.eventType).toBe("knowledge.searched");
    expect(row?.actorUserId).toBe("u_1");
    expect(row?.payload.query).toBe("receipts");
    expect(row?.payload.documents).toEqual(["d_1"]);
    expect(row?.payload.matched).toBe(1);

    // The passage is the document's text under another name. A trail that quotes it has copied the
    // document into a table with a different retention policy and a different audience.
    const serialised = JSON.stringify(row?.payload);
    expect(serialised).not.toContain("Meals under");
    expect(serialised).not.toContain("receipt.");
  });

  test("records a search that found nothing", async () => {
    // "This Bot was asked six times last week and found nothing" is a fact about the corpus, and it
    // only exists if the empty case writes a row too.
    const { search } = searchReturning([]);
    const { written, auditStore } = recorder();
    const tool = knowledgeSearchTool({
      search,
      auditStore,
      asker,
      botId: "knowledge",
    });

    await tool.execute({ query: "nothing" });

    expect(written).toHaveLength(1);
    expect(written[0]?.payload.matched).toBe(0);
    expect(written[0]?.payload.documents).toEqual([]);
  });

  test("answers a malformed call instead of ending the run", async () => {
    // An exception here ends the turn with nothing said. Same reasoning as the refusal path in
    // plugins/tools.ts.
    const { search, asked } = searchReturning(oneCitation);
    const { written, auditStore } = recorder();
    const tool = knowledgeSearchTool({
      search,
      auditStore,
      asker,
      botId: "knowledge",
    });

    const answer = await tool.execute({ notAQuery: 12 });

    expect(answer).toContain("needs a query");
    // And nothing was searched or recorded, because nothing was asked.
    expect(asked).toHaveLength(0);
    expect(written).toHaveLength(0);
  });
});
