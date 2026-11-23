import type { SettingsApprovalBodies, SettingsToolCards } from "./registry";
import { UpdateMyBotCard } from "./update-my-bot-card";
import { UpdateMySettingsCard } from "./update-my-settings-card";

/**
 * The cards for a person's own settings and Bots: `update_my_settings`, `update_my_bot`. One file
 * per tool beside this one, registered here by the tool's name.
 */
export const personalSettingsToolCards: SettingsToolCards = {
  update_my_settings: (props) => <UpdateMySettingsCard {...props} />,
  update_my_bot: (props) => <UpdateMyBotCard {...props} />,
};

/**
 * Their own bodies for the approval card, where a tool draws one. Both personal tools are drawn by
 * the shared before-and-after rows, which their previews already word as the screens do.
 */
export const personalSettingsApprovalBodies: SettingsApprovalBodies = {};
