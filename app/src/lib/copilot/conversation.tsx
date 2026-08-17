import { createContext, type ReactNode, useContext, useMemo } from "react";

/**
 * Lets transcript-rendered components add a user turn back into the containing conversation.
 */

type Conversation = {
  /** Submit a user turn from a transcript-rendered component. */
  ask: (text: string) => void;
};

const ConversationContext = createContext<Conversation | null>(null);

export function ConversationProvider({
  ask,
  children,
}: {
  ask: (text: string) => void;
  children: ReactNode;
}) {
  // Keep context identity stable across unrelated composer renders.
  const value = useMemo(() => ({ ask }), [ask]);
  return (
    <ConversationContext.Provider value={value}>
      {children}
    </ConversationContext.Provider>
  );
}

/** The conversation this component is drawn in, if it is drawn in one. */
export function useConversation(): Conversation | null {
  return useContext(ConversationContext);
}
