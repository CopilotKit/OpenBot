/**
 * Do not register a computer tool merely because the global Copilot provider is mounted.
 *
 * The API is the enforcement boundary too, but this prevents a disabled Bot from being told it has a
 * computer it can never use. An unknown profile is deliberately closed: tool registration happens
 * before a model sees its available tools, so offering first and withdrawing on a later fetch would
 * leak a call into the run.
 */
export function canOfferComputerTools(
  botId: string | undefined,
  profile: {
    data: { id: string; computerAccess: "enabled" | "disabled" } | undefined;
    isError: boolean;
    isFetching: boolean;
    isSuccess: boolean;
  },
): boolean {
  const data = profile.data;
  return (
    Boolean(botId) &&
    profile.isSuccess &&
    !profile.isFetching &&
    !profile.isError &&
    data?.id === botId &&
    data?.computerAccess === "enabled"
  );
}
