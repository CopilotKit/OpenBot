import type { SettingsApprovalBodies, SettingsToolCards } from "./registry";

/**
 * The cards for an admin's changes to the organization: `update_organization_settings`,
 * `manage_people`, `manage_teams`. One file per tool beside this one, registered here by name.
 */
export const adminSettingsToolCards: SettingsToolCards = {};

/** Their own bodies for the approval card, where a tool draws one. Optional per tool. */
export const adminSettingsApprovalBodies: SettingsApprovalBodies = {};
