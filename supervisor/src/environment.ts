/**
 * What a computer is told about itself.
 *
 * Kept separate from the HTTP server so the exact environment boundary is testable without
 * starting a listener or connecting to Docker. Nothing here is caller-supplied: a request says
 * which Bot, never what to run or what to set.
 */
export function environmentFor(
  botId: string,
  env: Record<string, string | undefined> = process.env,
): string[] {
  const passthrough = Object.entries(env).filter(([key]) =>
    key.startsWith("EGRESS_PROXY"),
  );
  const computerToken = env.COMPUTER_TOKEN;
  const spireSocketVolume = env.SPIRE_AGENT_SOCKET_VOLUME;
  const browserMode = env.COMPUTER_BROWSER_MODE;
  return [
    `COMPUTER_BOT_ID=${botId}`,
    ...(computerToken ? [`COMPUTER_TOKEN=${computerToken}`] : []),
    ...(spireSocketVolume
      ? ["SPIFFE_ENDPOINT_SOCKET=/tmp/spire-agent/public/api.sock"]
      : []),
    ...(browserMode ? [`COMPUTER_BROWSER_MODE=${browserMode}`] : []),
    ...passthrough.map(([key, value]) => `${key}=${value ?? ""}`),
  ];
}
