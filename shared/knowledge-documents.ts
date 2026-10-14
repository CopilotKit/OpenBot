/**
 * Wire format for attaching company documents to a turn.
 * Sent as a system message (not shown in the transcript UI); the server expands it.
 */
export const KNOWLEDGE_DOCUMENTS_MARKER = "[[openbot-knowledge-documents:";

export function knowledgeDocumentsSystemContent(
  documentIds: readonly string[],
): string | null {
  const unique = [
    ...new Set(documentIds.map((id) => id.trim()).filter(Boolean)),
  ];
  if (unique.length === 0) return null;
  return `${KNOWLEDGE_DOCUMENTS_MARKER}${unique.join(",")}]]`;
}

export function parseKnowledgeDocumentIds(content: string): string[] | null {
  const trimmed = content.trim();
  if (
    !trimmed.startsWith(KNOWLEDGE_DOCUMENTS_MARKER) ||
    !trimmed.endsWith("]]")
  ) {
    return null;
  }
  const inner = trimmed.slice(
    KNOWLEDGE_DOCUMENTS_MARKER.length,
    trimmed.length - 2,
  );
  return inner
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}
