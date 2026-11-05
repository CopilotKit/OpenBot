/** Which Bot an installation runs, by catalogue id; `agentUrl` only for an agent somebody runs. */
export type HarnessChoice = {
  id: string;
  agentUrl?: string;
};

/** What OpenBot sets up. David's call. */
export const DEFAULT_HARNESS = "langgraph";
