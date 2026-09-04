/**
 * A Bot's entitlement to the computer surface.
 *
 * This is independent of the action-policy CEL rules. The entitlement decides whether the tools and
 * routes exist for a Bot at all; CEL is the second boundary for a Bot that was deliberately enabled.
 * Existing deployments stored no setting before this field existed, so omission preserves their
 * established behaviour rather than turning an upgrade into a silent outage.
 */
export type ComputerAccess = "enabled" | "disabled";

export function computerAccessOf(configuration: unknown): ComputerAccess {
  if (!configuration || typeof configuration !== "object") return "disabled";
  if (!("computerAccess" in configuration)) return "enabled";
  return (configuration as { computerAccess?: unknown }).computerAccess ===
    "enabled"
    ? "enabled"
    : "disabled";
}
