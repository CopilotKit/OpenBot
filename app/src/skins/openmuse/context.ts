import { createContext, useContext } from "react";
import type { AgentProfile } from "@/lib/agents/queries";

export type MuseSheetKind = "menu" | "notifications" | "bots";

export type MuseContextValue = {
  /** The Bot at the centre of the frame, or undefined while the roster loads or when there is none. */
  bot: AgentProfile | undefined;
  /** The signed-in person, whose choice of centre Bot this browser remembers. */
  userId: string | undefined;
  openSheet: (sheet: MuseSheetKind) => void;
};

export const MuseContext = createContext<MuseContextValue | null>(null);

export function useMuse(): MuseContextValue {
  const context = useContext(MuseContext);
  if (!context)
    throw new Error("useMuse must be used inside the skin's frame.");
  return context;
}
