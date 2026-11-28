/**
 * Only the owner's Telegram chat may talk once they have sent the link code.
 *
 * Safer default than "anyone who finds the bot": unbound chats get instructions
 * and nothing runs; a second chat never joins an existing binding.
 */

export type AllowList = {
  has(chatId: string): boolean;
  add(chatId: string): void;
  clear(): void;
  size(): number;
};

export function createAllowList(seed: Iterable<string> = []): AllowList {
  const chats = new Set(
    [...seed].map(String).filter((id) => id.length > 0 && id.length <= 64),
  );
  return {
    has: (chatId) => chats.has(chatId),
    add: (chatId) => {
      if (chatId.length > 0 && chatId.length <= 64) chats.add(chatId);
    },
    clear: () => chats.clear(),
    size: () => chats.size,
  };
}
