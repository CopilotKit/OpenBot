import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

/**
 * Which Bot the surface in front of you is driving.
 *
 * The computer tools are registered once for the whole app, but a computer belongs to a Bot, and a supervisor gives
 * each one its own browser profile and its own egress, and the server picks which by the id in the
 * URL.
 *
 * Tool handlers read the ref because a handler outlives the render that registered it. Components
 * read state because grants and renderers must re-render when the active Bot changes.
 */

const DEFAULT_BOT_ID = "default";

type BotHolder = { current: string };

const ActiveBotContext = createContext<BotHolder | null>(null);
const ActiveBotValueContext = createContext<{
  botId: string;
  announce: (botId: string) => void;
} | null>(null);

export function ActiveBotProvider({ children }: { children: ReactNode }) {
  const holder = useRef<BotHolder>({ current: DEFAULT_BOT_ID });
  const [botId, setBotId] = useState(DEFAULT_BOT_ID);
  const value = useRef({ botId, announce: setBotId });
  value.current = { botId, announce: setBotId };

  return (
    <ActiveBotContext.Provider value={holder.current}>
      <ActiveBotValueContext.Provider value={value.current}>
        {children}
      </ActiveBotValueContext.Provider>
    </ActiveBotContext.Provider>
  );
}

/**
 * Declare the Bot this surface drives, for as long as it is mounted.
 *
 * Restores what it found on unmount, so leaving a channel does not leave its Bot addressed by
 * whatever mounts next.
 */
export function useActiveBot(botId: string | undefined): void {
  const holder = useContext(ActiveBotContext);
  const value = useContext(ActiveBotValueContext);
  useEffect(() => {
    if (!holder) return;
    const previous = holder.current;
    holder.current = botId ?? DEFAULT_BOT_ID;
    value?.announce(botId ?? DEFAULT_BOT_ID);
    return () => {
      holder.current = previous;
      value?.announce(previous);
    };
  }, [holder, value, botId]);
}

/** The holder itself, to be read inside a handler at the moment it runs. */
export function useActiveBotHolder(): BotHolder {
  return useContext(ActiveBotContext) ?? { current: DEFAULT_BOT_ID };
}

/** The active Bot as a value, for anything that has to re-render when it changes. */
export function useActiveBotId(): string {
  return useContext(ActiveBotValueContext)?.botId ?? DEFAULT_BOT_ID;
}
