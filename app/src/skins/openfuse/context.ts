import { createContext, useContext } from "react";
import type { AgentProfile } from "@/lib/agents/queries";

export type FuseSheetKind = "menu" | "notifications" | "bots";

export type FuseContextValue = {
  /** The Bot at the centre of the frame, or undefined while the roster loads or when there is none. */
  bot: AgentProfile | undefined;
  /**
   * Why there is no `bot`: the roster is still loading, or its read failed (the error). A screen
   * says either instead of "No Bots yet", which is true only of a roster that loaded empty.
   */
  roster: { pending: boolean; failed: unknown };
  /** The signed-in person, whose choice of centre Bot this browser remembers. */
  userId: string | undefined;
  openSheet: (sheet: FuseSheetKind) => void;
};

export const FuseContext = createContext<FuseContextValue | null>(null);

export function useFuse(): FuseContextValue {
  const context = useContext(FuseContext);
  if (!context)
    throw new Error("useFuse must be used inside the skin's frame.");
  return context;
}
