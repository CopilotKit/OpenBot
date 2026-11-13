/**
 * The tool a Bot calls to offer the person a check-in on one thing they just looked at together,
 * and what the card it draws reads from the call. The server runs it (server/src/proactive/offer-tool.ts);
 * the app draws its card (app/src/lib/copilot/check-in-offer-tool.tsx).
 */
export const OFFER_CHECK_IN_TOOL = "offer_check_in";

/**
 * How the tool's answer starts when there is nothing to offer: the thing was read some way a check-in
 * cannot read (the browser, the computer, a Shared app), or check-ins are off. The card is not drawn
 * for such a call.
 */
export const NOTHING_TO_OFFER = "Nothing to offer:";

/** What the Bot passes, and the card shows and sends back when the person accepts. */
export type CheckInOffer = {
  /** What to watch, in a few words the person reads: "Launch brief in Notion", "Your Gmail inbox". */
  subject: string;
  /** What to look for there, in the person's terms, for the check-in to read. */
  focus?: string;
  /** The page or place, where there is one to link to. */
  link?: string;
  /**
   * The tool the Bot read the thing with. The server works out from it what the check-in reads (an
   * app the person connected, or a public web page) and never takes a label for it.
   */
  readWith?: string;
};
