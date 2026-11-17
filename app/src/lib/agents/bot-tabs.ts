/**
 * The tabs of a Bot's own page, in the order they are drawn. Profile is the page as it opens; the
 * open tab is in the address (`?tab=`), so a link can open the page on one.
 */
export const BOT_TABS = ["profile", "activity", "settings"] as const;

export type BotTab = (typeof BOT_TABS)[number];

export const BOT_TAB_LABEL: Record<BotTab, string> = {
  profile: "Profile",
  activity: "Activity",
  settings: "Settings",
};

/** The tab an address asks for. Anything that is not one of them opens Profile. */
export function parseBotTab(value: unknown): BotTab {
  return BOT_TABS.find((tab) => tab === value) ?? "profile";
}
