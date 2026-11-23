import type { SettingsApprovalBodies, SettingsToolCards } from "./registry";

/**
 * The cards for a person's own settings and Bots: `update_my_settings`, `update_my_bot`. One file
 * per tool beside this one, registered here by the tool's name.
 */
export const personalSettingsToolCards: SettingsToolCards = {};

/** Their own bodies for the approval card, where a tool draws one. Optional per tool. */
export const personalSettingsApprovalBodies: SettingsApprovalBodies = {};
