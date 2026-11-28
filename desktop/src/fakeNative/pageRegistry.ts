/*
 * Every Desktop page command the OpenBot app can call when OpenBot Desktop shows it: the commands
 * of desktop_page.rs and the two of the notification plugin. pageRegistry.test.ts keeps this list
 * in step with the Rust source and with the app.
 */
export const PAGE_PLUGIN = "plugin:openbot-desktop";

export const PAGE_COMMANDS = [
  "plugin:notification|is_permission_granted",
  "plugin:notification|request_permission",
  "plugin:openbot-desktop|ai_connection",
  "plugin:openbot-desktop|ai_providers",
  "plugin:openbot-desktop|appearance",
  "plugin:openbot-desktop|await_sign_in_redirect",
  "plugin:openbot-desktop|begin_plan_sign_in",
  "plugin:openbot-desktop|begin_provider_sign_in",
  "plugin:openbot-desktop|begin_sign_in_redirect",
  "plugin:openbot-desktop|cancel_plan_sign_in",
  "plugin:openbot-desktop|cancel_provider_sign_in",
  "plugin:openbot-desktop|cancel_sign_in_redirect",
  "plugin:openbot-desktop|change_ai_connection",
  "plugin:openbot-desktop|change_connection",
  "plugin:openbot-desktop|check_update",
  "plugin:openbot-desktop|connection",
  "plugin:openbot-desktop|dismiss_update",
  "plugin:openbot-desktop|finish_plan_sign_in",
  "plugin:openbot-desktop|finish_provider_sign_in",
  "plugin:openbot-desktop|install_update",
  "plugin:openbot-desktop|intelligence",
  "plugin:openbot-desktop|move_to_cloud",
  "plugin:openbot-desktop|notify",
  "plugin:openbot-desktop|open_logs",
  "plugin:openbot-desktop|prepare_ai_connection",
  "plugin:openbot-desktop|quit",
  "plugin:openbot-desktop|record_problem",
  "plugin:openbot-desktop|restart",
  "plugin:openbot-desktop|save_logs",
  "plugin:openbot-desktop|set_organization",
  "plugin:openbot-desktop|set_usage_data",
  "plugin:openbot-desktop|settle_ai_connection",
  "plugin:openbot-desktop|sign_out",
  "plugin:openbot-desktop|speech_abort",
  "plugin:openbot-desktop|speech_available",
  "plugin:openbot-desktop|speech_start",
  "plugin:openbot-desktop|speech_stop",
  "plugin:openbot-desktop|status",
  "plugin:openbot-desktop|stop",
  "plugin:openbot-desktop|update_offer",
  "plugin:openbot-desktop|usage_data",
  "plugin:openbot-desktop|zoom",
] as const;

export type PageCommand = (typeof PAGE_COMMANDS)[number];

/**
 * A resolved call to one of these sends the real window back to the setup screens
 * (app/src/lib/desktop/mutations.ts).
 */
export const HANDBACK_COMMANDS = [
  "plugin:openbot-desktop|change_ai_connection",
  "plugin:openbot-desktop|change_connection",
  "plugin:openbot-desktop|move_to_cloud",
  "plugin:openbot-desktop|sign_out",
  "plugin:openbot-desktop|stop",
] as const;
