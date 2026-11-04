/**
 * This deployment's tables whose data moved into Intelligence with the Bot configuration, kept for one
 * release so an upgrading deployment still has the rows to copy (`upgrade.ts`), and written by nothing.
 *
 * `bot-configuration-no-local-writes` in the tests reads the source for a write to any of these and
 * fails when it finds one outside the upgrade copy.
 */
import {
  agentPreferences,
  botLifecycle,
  componentExclusions,
  componentFunctions,
  components,
  defaultOptOuts,
  deploymentPackages,
  pluginGrants,
  sandboxedComponents,
  skills,
  skillTools,
  teamBotAssignments,
  teamBotAudience,
  teamBotConsentDefaults,
  teamBotConsents,
  teamBotPublications,
  updateRoutingPreferences,
  userInstructions,
} from "../db/schema";

export const MOVED_TO_INTELLIGENCE = {
  agentPreferences,
  botLifecycle,
  componentExclusions,
  componentFunctions,
  components,
  defaultOptOuts,
  deploymentPackages,
  pluginGrants,
  sandboxedComponents,
  skills,
  skillTools,
  teamBotAssignments,
  teamBotAudience,
  teamBotConsentDefaults,
  teamBotConsents,
  teamBotPublications,
  updateRoutingPreferences,
  userInstructions,
} as const;
