import { GetMyBotsCard } from "./get-my-bots-card";
import { GetMySettingsCard } from "./get-my-settings-card";
import { GetOrganizationSettingsCard } from "./get-organization-settings-card";
import type { SettingsToolCards } from "./registry";
import { WhereDoIChangeCard } from "./where-do-i-change-card";

/**
 * The cards for reading settings and finding a screen: `get_my_settings`, `get_my_bots`,
 * `get_organization_settings`, `where_do_i_change`.
 */
export const coreSettingsToolCards: SettingsToolCards = {
  get_my_settings: GetMySettingsCard,
  get_my_bots: GetMyBotsCard,
  get_organization_settings: GetOrganizationSettingsCard,
  where_do_i_change: WhereDoIChangeCard,
};
