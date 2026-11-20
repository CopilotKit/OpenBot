/**
 * Internal starter Bots share one account-level tour.
 *
 * A starter Bot is recognised by which of the Bots OpenBot starts with it is (a Bot's
 * `packageBotId`), never by its own id: an organization's copy of one has a generated id.
 */
export function isStarterTourAgent(
  packageBotId: string | null | undefined,
): boolean {
  return (
    packageBotId === "picked-harness" || packageBotId === "personal-assistant"
  );
}
