import { createContext, type ReactNode, useContext } from "react";
import type { ListBotsScope } from "@/lib/api/generated/model";

/**
 * Whose Bots a screen lists: the ones the person can see (`caller`), or every Bot in the
 * organization (`organization`), which only Admin's screens ask for.
 *
 * A person's private Bot is theirs alone, so the Bots page, the home screen and every other place a
 * person picks or talks to a Bot list only what they can see, an admin included. Admin's screens
 * decide what Bots may hold (apps, components, skills, Learning, computers), so they list every Bot
 * in the organization, as they always have. Admin's layout sets this; everywhere else it is
 * `caller`.
 */
const BotListScope = createContext<ListBotsScope>("caller");

export function BotListScopeProvider({
  scope,
  children,
}: {
  scope: ListBotsScope;
  children: ReactNode;
}) {
  return (
    <BotListScope.Provider value={scope}>{children}</BotListScope.Provider>
  );
}

/** The scope of the screen this is drawn in. */
export function useBotListScope(): ListBotsScope {
  return useContext(BotListScope);
}
