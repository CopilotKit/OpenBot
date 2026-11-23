import type { AppScene } from "../../../desktop/workbench/appContract";
import { skinScenes } from "../skins";
import { ACCOUNT_SCENES } from "./account";
import { COMPUTER_SCENES } from "./computer";
import { CONNECTIONS_SCENES } from "./connections";
import { CONVERSATION_SCENES } from "./conversation";
import { HOME_SCENES } from "./home";
import { SETTINGS_SCENES } from "./settings";

export const APP_SCENES: readonly AppScene[] = [
  ...HOME_SCENES,
  ...SETTINGS_SCENES,
  ...CONNECTIONS_SCENES,
  ...COMPUTER_SCENES,
  ...CONVERSATION_SCENES,
  ...ACCOUNT_SCENES,
  // The main Bot page and Settings → Connections in every skin, with the sidebar open and closed.
  ...[...HOME_SCENES, ...CONNECTIONS_SCENES]
    .filter(
      (s) => s.id === "app-home-bots" || s.id === "app-settings-connections",
    )
    .flatMap(skinScenes),
];
