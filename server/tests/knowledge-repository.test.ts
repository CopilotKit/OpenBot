import { describe, expect, test } from "bun:test";
import { InMemoryKnowledgeRepository } from "../src/knowledge/repository";

const change = {
  connectorInstanceId: "connector-1",
  sourceId: "source-1",
  title: "Finance policy",
  canonicalUrl: "https://example.test/policy",
  contentHash: "hash-1",
  chunks: [{ position: 0, content: "finance content" }],
  acls: [{ principal: "group:finance", effect: "allow" as const }],
};

describe("knowledge repository", () => {
  test("replaces source content idempotently", () => {
    const repository = new InMemoryKnowledgeRepository();
    repository.apply(change);
    repository.apply({
      ...change,
      contentHash: "hash-2",
      chunks: [{ position: 0, content: "updated" }],
    });

    expect(repository.documents()).toEqual([
      {
        ...change,
        contentHash: "hash-2",
        chunks: [{ position: 0, content: "updated" }],
      },
    ]);
  });

  test("returns citations only to authorized actors and hides deleted sources", () => {
    const repository = new InMemoryKnowledgeRepository();
    repository.apply(change);
    expect(repository.search({ userId: "u1", groups: ["finance"] })).toEqual([
      {
        documentId: "connector-1:source-1",
        title: "Finance policy",
        canonicalUrl: "https://example.test/policy",
        chunkId: "connector-1:source-1:0",
        content: "finance content",
      },
    ]);
    expect(repository.search({ userId: "u2", groups: [] })).toEqual([]);
    repository.delete("connector-1", "source-1");
    expect(repository.search({ userId: "u1", groups: ["finance"] })).toEqual(
      [],
    );
  });
});
