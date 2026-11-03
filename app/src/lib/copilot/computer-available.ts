import type { CapabilityKey } from "@/lib/enterprise/queries";
import type { OfferRule } from "./bot-offer";

/** Which computer tools this conversation offers the Bot. */
export type ComputerToolsOffered = {
  /** Acting on the page that is open: reading it, clicking, typing, scrolling. */
  browser: boolean;
  /** Opening a page, which is the browser plus the network. */
  navigate: boolean;
  /** The computer behind the screen: its files and its shell. */
  computer: boolean;
};

/**
 * Whether this chat may use the Bot's computer, and which parts of it.
 *
 * TWO QUESTIONS, NOT ONE. The first is whose computer it is: the computer carries its owner's
 * signed-in browser, and these tools run from this browser on the person's own session, so the
 * server refuses every computer route (and every sign-in into it) to a Team Bot's teammates. The
 * second is what the deployment allows anybody at all — the capability switches an administrator
 * set, which the computer boundary enforces on every `computer_*` call in `decideFromSnapshot`.
 *
 * MIRRORING THAT SERVER-SIDE SPLIT IS THE POINT, and it is a split by intent rather than by tool:
 * files and commands need `cloudComputer`, everything else on the computer needs `cloudBrowser`,
 * and opening a page needs `cloudNetwork` on top. A Bot offered a tool whose capability is off does
 * not fail safe into silence — it reaches for the tool, gets a refusal, and spends the turn saying
 * so, which is how asking a Bot a question about an app it holds no tools for ended with its screen
 * opening on nothing.
 *
 * Pure, and separate from the offers below, because every one of those rules is worth stating in a
 * test without a router, a query client and a profile fetch around it.
 */
export function computerToolsOffered({
  profile,
  capabilities,
}: {
  /** Undefined when it could not be read, or the run names no Bot: then nothing is offered. */
  profile: { visibility: string; canManage: boolean } | undefined;
  capabilities: Partial<Record<CapabilityKey, boolean>> | undefined;
}): ComputerToolsOffered {
  const mine = computerDrivable(profile);
  // An unresolved switch reads as allowed: the switches are the deployment's, and the computer
  // boundary refuses on every call anyway.
  const allows = (capability: CapabilityKey) =>
    capabilities?.[capability] !== false;
  const browser = mine && allows("cloudBrowser");
  return {
    browser,
    navigate: browser && allows("cloudNetwork"),
    computer: mine && allows("cloudComputer"),
  };
}

/**
 * Whether this browser may drive the Bot's computer at all, capabilities aside.
 *
 * The first of the two questions above, on its own. `report_refusal` rides on it: recording that a
 * Bot declined something is audit bookkeeping rather than a computer action, so it stays offered
 * wherever the Bot is this person's to drive, whatever the computer switches say.
 */
export function computerDrivable(
  profile: { visibility: string; canManage: boolean } | undefined,
): boolean {
  /*
   * UNKNOWN IS NO. A computer belongs to a Bot, and a Bot nobody could read may be a Team Bot whose
   * computer this person may not drive; a run that names no Bot at all has no computer, and its call
   * would fall back to whichever Bot is on screen. Both used to be offered every computer tool.
   */
  if (!profile) return false;
  return profile.visibility === "public" || profile.canManage;
}

/**
 * The rules above as offers, asked of the Bot whose run it is rather than the one on screen. See
 * `bot-offer.ts`.
 */
export const offeredBrowser: OfferRule = (bot) =>
  computerToolsOffered(bot).browser;
export const offeredNavigate: OfferRule = (bot) =>
  computerToolsOffered(bot).navigate;
export const offeredComputer: OfferRule = (bot) =>
  computerToolsOffered(bot).computer;
export const offeredDrivable: OfferRule = (bot) =>
  computerDrivable(bot.profile);
