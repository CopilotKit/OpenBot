/** The CLI key is authoritative after reconnecting; older deployments may use the legacy name. */
export function intelligenceApiKey(
  environment: Record<string, string | undefined>,
): string | undefined {
  return (
    environment.CPK_INTELLIGENCE_API_KEY?.trim() ||
    environment.INTELLIGENCE_API_KEY?.trim() ||
    undefined
  );
}
