import type { RunStore } from "../storage/run-store";

export interface SanitizedMessage {
  id: string;
  role: "system" | "user" | "assistant";
  content: string;
}

export interface PreparedProviderRun {
  sessionId?: string;
  messages: SanitizedMessage[];
  acknowledgedMessageId?: string;
}

const MESSAGE_ID = /^[A-Za-z0-9._:-]{1,200}$/;
const ROLES = new Set(["system", "user", "assistant"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textContent(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  const parts: string[] = [];
  for (const item of value) {
    if (
      !isRecord(item) ||
      item.type !== "text" ||
      typeof item.text !== "string"
    ) {
      continue;
    }
    parts.push(item.text);
  }
  return parts.join("");
}

export function sanitizeMessages(
  messages: readonly unknown[],
): SanitizedMessage[] {
  const seen = new Set<string>();
  return messages.map((message) => {
    if (!isRecord(message)) throw new Error("Invalid transcript message.");
    const { id, role } = message;
    const content = textContent(message.content);
    if (typeof id !== "string" || !MESSAGE_ID.test(id)) {
      throw new Error("Invalid transcript message ID.");
    }
    if (seen.has(id)) throw new Error(`Duplicate message ID: ${id}.`);
    seen.add(id);
    if (typeof role !== "string" || !ROLES.has(role)) {
      throw new Error("Invalid transcript message role.");
    }
    if (content === undefined)
      throw new Error("Invalid transcript message content.");
    return { id, role: role as SanitizedMessage["role"], content };
  });
}

export function prepareProviderRun(
  store: RunStore,
  provider: string,
  threadId: string,
  rawMessages: readonly unknown[],
): PreparedProviderRun {
  const messages = sanitizeMessages(rawMessages);
  let session = store.getSession(provider, threadId);
  let delta = messages;
  const acknowledgedMessageId = session?.acknowledgedMessageId;
  if (acknowledgedMessageId) {
    const acknowledgedIndex = messages.findIndex(
      (message) => message.id === acknowledgedMessageId,
    );
    if (acknowledgedIndex >= 0) delta = messages.slice(acknowledgedIndex + 1);
    else session = undefined;
  }
  const last = messages.at(-1);
  return {
    ...(session ? { sessionId: session.sessionId } : {}),
    messages: delta,
    ...(last ? { acknowledgedMessageId: last.id } : {}),
  };
}
