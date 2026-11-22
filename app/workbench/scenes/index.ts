import type { AppScene } from "../../../desktop/workbench/appContract";
import { ACCOUNT_SCENES } from "./account";
import { COMPUTER_SCENES } from "./computer";
import { CONVERSATION_SCENES } from "./conversation";
import { HOME_SCENES } from "./home";
import { SETTINGS_SCENES } from "./settings";

export const APP_SCENES: readonly AppScene[] = [
  ...HOME_SCENES,
  ...SETTINGS_SCENES,
  ...COMPUTER_SCENES,
  ...CONVERSATION_SCENES,
  ...ACCOUNT_SCENES,
];
