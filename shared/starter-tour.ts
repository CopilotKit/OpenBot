/** Internal starter Bots share one account-level tour. */
export function isStarterTourAgent(agentId: string): boolean {
  return agentId === "picked-harness" || agentId === "personal-assistant";
}
