import type { SettingsApprovalBodies, SettingsToolCards } from "./registry";
import { UpdateBotAppsCard } from "./update-bot-apps-card";
import { UpdateMyBotCard } from "./update-my-bot-card";
import { UpdateMySettingsCard } from "./update-my-settings-card";

/**
 * The cards for a person's own settings and Bots: `update_my_settings`, `update_my_bot`,
 * `update_bot_apps`. One file per tool beside this one, registered here by the tool's name.
 */
export const personalSettingsToolCards: SettingsToolCards = {
  update_my_settings: (props) => <UpdateMySettingsCard {...props} />,
  update_my_bot: (props) => <UpdateMyBotCard {...props} />,
  update_bot_apps: (props) => <UpdateBotAppsCard {...props} />,
};

/**
 * Their own bodies for the approval card, where a tool draws one. The personal tools are drawn by
 * the shared before-and-after rows, which their previews already word as the screens do. The
 * approval's title names the Bot and the app (`update_bot_apps`: "Change what Scout can use in
 * Gmail"), so the rows need nothing more.
 */
export const personalSettingsApprovalBodies: SettingsApprovalBodies = {};
