/** Which Bot an installation runs, by catalogue id; `agentUrl` only for an agent somebody runs. */
export type HarnessChoice = {
  id: string;
  agentUrl?: string;
};

/** What OpenBot sets up. David's call. */
export const DEFAULT_HARNESS = "langgraph-ts";

/**
 * The Bot an installation's saved choice means in this release.
 *
 * `langgraph`, the Python LangGraph image, was the default Bot until the TypeScript one replaced it,
 * and this window has no picker: an installation that saved `langgraph` took the default. It runs the
 * default now, as `harness::picked` in the native side resolves it, so this window names it the same
 * way and still knows the installation it is returning to.
 */
export function currentChoice(choice: HarnessChoice): HarnessChoice {
  return choice.id === "langgraph"
    ? { ...choice, id: DEFAULT_HARNESS }
    : choice;
}
