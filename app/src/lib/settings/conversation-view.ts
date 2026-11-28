import { useCallback, useSyncExternalStore } from "react";

/**
 * How the Conversations panel lists conversations. `compact` is one line each, a small avatar and
 * the title, as Claude's sidebar lists chats; `detailed` is the two lines the list always had, the
 * Bot's name over the title. Compact unless this browser chose otherwise.
 */
export type ConversationView = "compact" | "detailed";

/** Where this browser remembers the view. Only this browser: it is not saved to the account. */
export const CONVERSATION_VIEW_STORAGE_KEY = "openbot-conversation-view";

/** The view a stored value names, Compact for anything else, a missing value included. */
export function readConversationView(stored: string | null): ConversationView {
  return stored === "detailed" ? "detailed" : "compact";
}

const listeners = new Set<() => void>();
/** The view chosen in this page, for when storage refuses to keep it. */
let chosen: ConversationView | null = null;

function stored(): ConversationView {
  if (chosen) return chosen;
  try {
    return readConversationView(
      window.localStorage.getItem(CONVERSATION_VIEW_STORAGE_KEY),
    );
  } catch {
    // Storage refused (a private window, blocked site data): the default, every time.
    return "compact";
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The panel's view, and a way to change it that every reader of it sees at once. */
export function useConversationView(): [
  ConversationView,
  (view: ConversationView) => void,
] {
  const view = useSyncExternalStore<ConversationView>(
    subscribe,
    stored,
    () => "compact",
  );
  const change = useCallback((next: ConversationView) => {
    try {
      window.localStorage.setItem(CONVERSATION_VIEW_STORAGE_KEY, next);
      chosen = null;
    } catch {
      // Not remembered past this page, but changed for as long as it stays open.
      chosen = next;
    }
    for (const listener of listeners) listener();
  }, []);
  return [view, change];
}
