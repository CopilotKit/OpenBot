import type { ComputerNames } from "./names";

/**
 * What a computer is told about itself.
 *
 * Kept separate from the HTTP server so the exact environment boundary is testable without
 * starting a listener or connecting to Docker. Nothing here is caller-supplied: a request says
 * whose computer, never what to run or what to set.
 */
export function environmentFor(
  names: Pick<ComputerNames, "kind" | "id">,
  env: Record<string, string | undefined> = process.env,
): string[] {
  const passthrough = Object.entries(env).filter(([key]) =>
    key.startsWith("EGRESS_PROXY"),
  );
  const computerToken = env.COMPUTER_TOKEN?.trim() || undefined;
  const spireSocketVolume = env.SPIRE_AGENT_SOCKET_VOLUME;
  // Fail fast here rather than forwarding an invalid mode that crashes the child at
  // `browserModeFromEnv`: whitespace-only is falsy after trim, anything else must be headless
  // or headed.
  const rawBrowserMode = env.COMPUTER_BROWSER_MODE?.trim() || undefined;
  if (
    rawBrowserMode !== undefined &&
    rawBrowserMode !== "headless" &&
    rawBrowserMode !== "headed"
  ) {
    throw new Error(
      `COMPUTER_BROWSER_MODE must be headless or headed, not ${JSON.stringify(env.COMPUTER_BROWSER_MODE)}.`,
    );
  }
  const browserMode = rawBrowserMode;
  return [
    /*
     * The seat a request that names no Bot falls back to. An isolated Bot's computer is that Bot's,
     * as every computer was before; a person's computer carries several Bots and leaves the default.
     */
    ...(names.kind === "bot" ? [`COMPUTER_BOT_ID=${names.id}`] : []),
    // And a person's computer is told it is that person's: Record runs in its Bots' browsers, which it refuses on the
    // computer every person shares (agent-computer's person-access.ts).
    ...(names.kind === "person" ? [`COMPUTER_PERSON_ID=${names.id}`] : []),
    /*
     * A folder each. A person's computer carries every Bot that person uses, and each keeps its own
     * files and starts its shell there, as each keeps its own browser profile. On an isolated Bot's
     * computer there is one Bot and one folder, which is the same rule with nothing to separate.
     */
    "COMPUTER_SEPARATE_WORKSPACES=on",
    ...(computerToken ? [`COMPUTER_TOKEN=${computerToken}`] : []),
    ...(spireSocketVolume
      ? ["SPIFFE_ENDPOINT_SOCKET=/tmp/spire-agent/public/api.sock"]
      : []),
    ...(browserMode ? [`COMPUTER_BROWSER_MODE=${browserMode}`] : []),
    ...passthrough.map(([key, value]) => `${key}=${value ?? ""}`),
  ];
}
