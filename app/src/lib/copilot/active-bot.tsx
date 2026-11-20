import type { FrontendToolHandlerContext } from "@copilotkit/react-core/v2";
import {
  createContext,
  type ReactNode,
  useCallback,
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
 * Components read state because grants and renderers must re-render when the active Bot changes. A
 * tool handler does not read this to learn which Bot it is acting for: see `botOfCall`.
 */

const DEFAULT_BOT_ID = "default";

/**
 * The local id a channel registers its agent under, which routes to the Bot by `runtimeAgentId`.
 *
 * Here rather than in the channel so `botOfCall` can refuse it by the same spelling the channel uses.
 */
const CHANNEL_AGENT_PREFIX = "channel:";

export function channelAgentId(channelId: string): string {
  return `${CHANNEL_AGENT_PREFIX}${channelId}`;
}

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

/**
 * The holder itself, read at the moment it is needed rather than at render.
 *
 * For a renderer drawing a call in the conversation on screen, whose Bot is the screen's. A handler
 * wants `useBotOfCall` instead.
 */
export function useActiveBotHolder(): BotHolder {
  return useContext(ActiveBotContext) ?? { current: DEFAULT_BOT_ID };
}

/** What a handler is told about the agent that made its call. Only the ids are read. */
export type CallingAgent = { agentId?: string; runtimeAgentId?: string };

/**
 * What the SDK hands a frontend tool's handler, taken from the SDK's own type so the handlers here
 * cannot drift from it. Every part optional: a handler is also called by tests and by the approval
 * gate's wrapper, which pass only what they have.
 */
export type ToolCallContext = Partial<FrontendToolHandlerContext>;

/**
 * The Bot a tool call was made by, which is not always the Bot on screen.
 *
 * A RUN OUTLIVES THE SCREEN THAT STARTED IT. The provider is app-wide, so a turn the person walked
 * away from keeps going, and every frontend tool it calls is handled here while something else is
 * on screen: a page with no conversation, where the placeholder holds, or another Bot's
 * conversation. The handlers used to ask the screen which Bot they were acting for. A record the Bot
 * drew while its person was on another page was checked against the placeholder, the server
 * answered that there is no such Bot, and the person came back to "This deployment could not be
 * asked whether that component is allowed" where the record should have been. In another Bot's
 * conversation it was the wrong Bot that was asked about: its grants, and its computer.
 *
 * The call knows. The SDK hands every handler the agent that made the call. A channel registers
 * its agent under a local id of its own (`channelAgentId`) and routes it to the Bot through
 * `runtimeAgentId`; a Bot's own page binds to the Bot's agent directly, whose `agentId` is the Bot.
 * Neither the local id nor the placeholder is ever taken for a Bot. Only a call that names no Bot
 * falls back to the screen, which in the app is one made through the browser's WebMCP API rather
 * than by a run: it has no agent at all.
 *
 * This decides which question is asked, not whether the answer is trusted. The server still checks
 * the person's access to the Bot, the Bot's grants and the computer route for whatever id it is
 * handed.
 */
export function botOfCall(
  agent: CallingAgent | undefined,
  onScreen: string,
): string {
  return botOfAgent(agent) ?? onScreen;
}

/** The Bot an agent runs, as `botOfCall` reads it, or undefined when it names none. */
export function botOfAgent(
  agent: CallingAgent | undefined,
): string | undefined {
  for (const id of [agent?.runtimeAgentId, agent?.agentId]) {
    if (
      typeof id === "string" &&
      id.trim() !== "" &&
      id !== DEFAULT_BOT_ID &&
      !id.startsWith(CHANNEL_AGENT_PREFIX)
    )
      return id;
  }
  return undefined;
}

/**
 * `botOfCall` for a handler, with the screen read only at the moment a call is handled.
 *
 * Stable for the provider's life, so the SDK's once-registered handler may keep it.
 */
export function useBotOfCall(): (agent: CallingAgent | undefined) => string {
  const holder = useActiveBotHolder();
  return useCallback((agent) => botOfCall(agent, holder.current), [holder]);
}

/** The active Bot as a value, for anything that has to re-render when it changes. */
export function useActiveBotId(): string {
  return useContext(ActiveBotValueContext)?.botId ?? DEFAULT_BOT_ID;
}

/**
 * The active Bot when a surface has declared one, and undefined while the placeholder holds.
 *
 * The placeholder exists so a handler always has something to route with, but it is not a Bot: no
 * package registers an agent by that name, and the server answers 404 for it. A grant query handed
 * the placeholder therefore polls a guaranteed miss on its own interval — every few seconds, on
 * every screen without a conversation — and the constant failing request is noise that would bury a
 * real 404 the day one matters. A query given undefined instead simply does not run.
 *
 * The name is already reserved in practice: an agents.yaml entry called "default" would be
 * indistinguishable from the placeholder in every handler that reads the holder.
 */
export function declaredBotId(botId: string): string | undefined {
  return botId === DEFAULT_BOT_ID ? undefined : botId;
}

/** As useActiveBotId, for callers that should do nothing while the placeholder holds. */
export function useDeclaredBotId(): string | undefined {
  return declaredBotId(useActiveBotId());
}
