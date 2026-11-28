import type { HistoryLocation, RouterHistory } from "@tanstack/react-router";
import type { NativeTab } from "./bridge";

const sections = {
  bots: { path: "/bots", label: "Bots" },
  conversations: { path: "/conversations", label: "Chats" },
  home: { path: "/", label: "Home" },
} as const;

export type ConversationParent = { tab: NativeTab; index: number };
const parents = new WeakMap<RouterHistory, Map<string, ConversationParent>>();
const storageKey = "openbot-native-conversation-parent";

export function isConversationPath(path: string) {
  return /^\/(channel|group|start)\/[^/]+\/?$/.test(path);
}

/** Save only the originating tab and history index, scoped to this browser entry. */
export function trackConversationParents(history: RouterHistory) {
  const entries = parents.get(history) ?? new Map<string, ConversationParent>();
  parents.set(history, entries);
  let previous = history.location;
  try {
    const saved = JSON.parse(sessionStorage.getItem(storageKey) ?? "null");
    if (
      saved &&
      saved.key === previous.state.__TSR_key &&
      Object.hasOwn(sections, saved.tab) &&
      Number.isInteger(saved.index)
    ) {
      entries.set(saved.key, { tab: saved.tab, index: saved.index });
    }
  } catch {
    /* Storage is optional. A direct link can always go to Chats. */
  }

  return history.subscribe(({ location, action }) => {
    const from = previous;
    previous = location;
    const key = location.state.__TSR_key;
    if (!key || !isConversationPath(location.pathname)) return;
    if (action.type === "PUSH" || action.type === "REPLACE") {
      const root = (Object.keys(sections) as NativeTab[]).find(
        (tab) =>
          sections[tab].path === (from.pathname.replace(/\/+$/, "") || "/"),
      );
      const parent = root
        ? { tab: root, index: from.state.__TSR_index }
        : entries.get(from.state.__TSR_key ?? "");
      if (parent) entries.set(key, parent);
    }
    try {
      sessionStorage.setItem(
        storageKey,
        JSON.stringify({ key, ...entries.get(key) }),
      );
    } catch {
      /* The in-memory history still works. */
    }
  });
}

export function conversationParent(
  history: RouterHistory,
  location: Pick<HistoryLocation, "state">,
) {
  const parent = parents.get(history)?.get(location.state.__TSR_key ?? "");
  const tab = parent?.tab ?? "conversations";
  return { ...sections[tab], tab, index: parent?.index };
}
