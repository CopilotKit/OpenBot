import { ORGANIZATION_ID } from "@/lib/api/request";

/** Personal organization on this browser only; no tag API exists in the published backend. */
export function rosterTagKey(userId: string, botId: string): string {
  return `openbot:roster-tags:v1:${encodeURIComponent(ORGANIZATION_ID)}:${encodeURIComponent(userId)}:${encodeURIComponent(botId)}`;
}

export function normalizeTags(tags: readonly string[]): string[] {
  const unique = new Map<string, string>();
  for (const raw of tags) {
    const tag = raw.trim().replace(/\s+/g, " ");
    if (!tag) continue;
    if (tag.length > 40)
      throw new Error("Each tag must be 40 characters or fewer.");
    const key = tag.toLocaleLowerCase();
    if (!unique.has(key)) unique.set(key, tag);
  }
  if (unique.size > 20) throw new Error("Use up to 20 tags per Bot.");
  return [...unique.values()];
}

export function readBotTags(
  userId: string | undefined,
  botId: string,
): string[] {
  if (!userId) return [];
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(rosterTagKey(userId, botId)) ?? "[]",
    );
    if (!Array.isArray(value) || !value.every((tag) => typeof tag === "string"))
      return [];
    return normalizeTags(value);
  } catch {
    return [];
  }
}

/** Throws on invalid input or unavailable storage so the editor never pretends a failed save worked. */
export function writeBotTags(
  userId: string | undefined,
  botId: string,
  tags: readonly string[],
): void {
  if (!userId) throw new Error("Sign in to save personal tags.");
  const normalized = normalizeTags(tags);
  const key = rosterTagKey(userId, botId);
  if (normalized.length) localStorage.setItem(key, JSON.stringify(normalized));
  else localStorage.removeItem(key);
}
