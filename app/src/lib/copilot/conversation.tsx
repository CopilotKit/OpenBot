import {
  createContext,
  type ReactNode,
  useContext,
  useMemo,
  useState,
} from "react";
import { CarryOnGroup } from "./carry-on-group";

/**
 * Lets transcript-rendered components add a user turn back into the containing conversation.
 */

type Conversation = {
  /** Submit a user turn from a transcript-rendered component. */
  ask: (text: string) => void;
  /** The app cards that carry this conversation's task on together. See `carry-on-group.ts`. */
  carryOn: CarryOnGroup;
};

const ConversationContext = createContext<Conversation | null>(null);

export function ConversationProvider({
  ask,
  children,
}: {
  ask: (text: string) => void;
  children: ReactNode;
}) {
  // One for the life of the conversation, whatever `ask` is from render to render.
  const [carryOn] = useState(() => new CarryOnGroup());
  // Keep context identity stable across unrelated composer renders.
  const value = useMemo(() => ({ ask, carryOn }), [ask, carryOn]);
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
