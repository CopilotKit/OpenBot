/**
 * What the cards in a conversation share, provided once by the screen: which tool calls are still
 * streaming their arguments, what the person answered the Bot's questions, and how a report reads its
 * figures. Anywhere else (the dev gallery) nothing streams, nothing is answered and nothing is read.
 */
import { createContext } from "react";
import type { Answer } from "./drawn";

export type ReportRead = {
  allowed: boolean;
  data?: unknown;
  reason?: string;
};

export type DrawnSetting = {
  arriving: ReadonlySet<string>;
  answers: ReadonlyMap<string, Answer>;
  /** Reads a report's figures as the Bot that drew it (callComponentFunction). */
  readReport?: (
    botId: string | null,
    name: string,
    args: Record<string, unknown>,
  ) => Promise<ReportRead>;
  /** A Bot's name by its id, as people know it. */
  botName?: (id: string) => string | undefined;
};

export const DrawnContext = createContext<DrawnSetting>({
  arriving: new Set(),
  answers: new Map(),
});
