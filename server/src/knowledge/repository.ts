import { canRead } from "./acl";
import type { KnowledgeAclEntry, KnowledgeActor } from "./types";

type SourceChange = {
  connectorInstanceId: string;
  sourceId: string;
  title: string;
  canonicalUrl: string;
  contentHash: string;
  chunks: { position: number; content: string }[];
  acls: KnowledgeAclEntry[];
};

type Citation = {
  documentId: string;
  title: string;
  canonicalUrl: string;
  chunkId: string;
  content: string;
};

export class InMemoryKnowledgeRepository {
  #sources = new Map<string, SourceChange>();
  #deleted = new Set<string>();

  apply(change: SourceChange) {
    const key = sourceKey(change.connectorInstanceId, change.sourceId);
    this.#sources.set(key, structuredClone(change));
    this.#deleted.delete(key);
  }

  delete(connectorInstanceId: string, sourceId: string) {
    this.#deleted.add(sourceKey(connectorInstanceId, sourceId));
  }

  documents(): SourceChange[] {
    return [...this.#sources.values()].map((source) => structuredClone(source));
  }

  search(actor: KnowledgeActor): Citation[] {
    return [...this.#sources.entries()].flatMap(([key, source]) => {
      if (this.#deleted.has(key) || !canRead(actor, source.acls)) return [];
      const documentId = key;
      return source.chunks.map((chunk) => ({
        documentId,
        title: source.title,
        canonicalUrl: source.canonicalUrl,
        chunkId: `${documentId}:${chunk.position}`,
        content: chunk.content,
      }));
    });
  }
}

function sourceKey(connectorInstanceId: string, sourceId: string) {
  return `${connectorInstanceId}:${sourceId}`;
}
