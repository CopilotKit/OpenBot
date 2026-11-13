import { SHOW_APP_ACCESS_TOOL } from "@openbot/shared/connect-prompt";
import {
  NOTHING_TO_OFFER,
  OFFER_CHECK_IN_TOOL,
} from "@openbot/shared/check-in-offer";
import type { GrantedTool } from "@openbot/toolkit/granted-tool";
import { z } from "zod";
import type { CheckInSource } from "./scope";
import { publicPageAddress } from "./source";
import type { ProactiveSetting } from "./types";

/**
 * The tool every Bot holds for offering the person a check-in on one thing.
 *
 * ASKED, NEVER ASSUMED. Check-ins used to switch themselves on the first time a person talked to a
 * Bot, and then read everything it could reach every hour: a person who never asked found their
 * Bots list full of things it had decided were theirs. Now a Bot offers one, about the one thing
 * the two of them just looked at, and nothing runs until the person accepts on the card.
 *
 * ONLY WHAT A CHECK-IN CAN LOOK AT. The Bot names the tool it read the thing with (`readWith`) and
 * the server works out from it what the check-in would read: one app the person connected with their
 * own account, or one public web page. Anything else (the browser, the computer, a Shared app, an app
 * on the admin's key) has nothing to offer, and the answer says so and what to do instead. FOUND IN
 * AN AUDIT: a Bot offered a check-in on a GitHub releases page it had read in its browser, the card
 * said it checked the page once a day, and it never ran once.
 *
 * A READ, AND ONLY EVER ONE. This writes nothing. It answers whether there is anything to offer
 * (check-ins allowed, something a check-in can read, not already watching it), and the card in front
 * of the person does the rest: Turn on creates the check-in as them, through the same route the
 * Bot's check-ins page uses, and the server works the kind out again from `readWith`.
 */
export function checkInOfferTools(options: {
  ownerUserId: string;
  agentId: string;
  /** Whether this person may have check-ins at all (an admin can turn them off). */
  allowed(ownerUserId: string): Promise<boolean>;
  /** This person's check-ins, to tell an offer from one already running. */
  list(ownerUserId: string): Promise<ProactiveSetting[]>;
  /** What a check-in on something this Bot read with the named tool would read. */
  sourceOf(toolName: string): Promise<CheckInSource>;
  /** Whether this Bot holds a tool that reads a web page by its address. */
  readsPages(): Promise<boolean>;
}): GrantedTool[] {
  const parameters = z
    .object({
      subject: z
        .string()
        .trim()
        .min(1)
        .max(120)
        .describe(
          'What to watch, in a few words the person would use: "Launch brief in Notion", "Your Gmail inbox".',
        ),
      focus: z
        .string()
        .trim()
        .max(500)
        .optional()
        .describe(
          "What to look for there, if the conversation said: new comments, replies from Ana, anything due this week.",
        ),
      link: z
        .string()
        .trim()
        .max(2000)
        .optional()
        .describe(
          "The page's web address, when it has one. Required for a public web page.",
        ),
      readWith: z
        .string()
        .trim()
        .min(1)
        .max(256)
        .describe(
          "The name of the tool you just read it with, exactly as you called it.",
        ),
    })
    .strict();
  const nothing = (why: string) => `${NOTHING_TO_OFFER} ${why}`;
  return [
    {
      name: OFFER_CHECK_IN_TOOL,
      ref: `check-ins/${OFFER_CHECK_IN_TOOL}`,
      description: [
        "Offer the person a daily check-in on one thing you just looked at together: you read it once a day and tell them only when something there needs them.",
        "Offer it after you read something that keeps changing and that they care about over time: a document being worked on, a project page, their inbox, a channel, a public web page. Not for a one-off lookup, such as a fact read off a page.",
        "A check-in can read an app the person connected with their own account, or one public web page. Name the tool you read it with as readWith; for a web page, pass its address as link.",
        "Offer at most once per thing in a conversation, and never again once they said no. The card asks them; do not ask in words as well.",
      ].join(" "),
      parameters,
      async execute(args) {
        const parsed = parameters.safeParse(args);
        if (!parsed.success)
          return "Say what the check-in would watch, and name the tool you read it with as readWith.";
        const { subject, link, readWith } = parsed.data;
        if (!(await options.allowed(options.ownerUserId)))
          return nothing(
            "Check-ins are turned off for this person. Do not offer again.",
          );
        const source = await options.sourceOf(readWith);
        if (source?.kind === "unreadable")
          return nothing(
            `A check-in reads only apps the person connected with their own account, and you can't read ${source.title} as them. Call ${SHOW_APP_ACCESS_TOOL} for ${source.title} so they can connect it, and offer again once they have.`,
          );
        if (!source)
          return nothing(
            `A check-in can only read an app the person connected with their own account, or a public web page, and you read ${subject} another way. If connecting an app would let you read it, call ${SHOW_APP_ACCESS_TOOL} for that app. Otherwise, offer to set up a routine instead. Do not offer a check-in on it again.`,
          );
        if (source.kind === "page") {
          if (!link || !publicPageAddress(link))
            return nothing(
              "A check-in on a web page needs the page's public address, starting with https://. Offer again with it as link, or carry on.",
            );
          if (!(await options.readsPages()))
            return nothing(
              "You have no tool that reads a web page by its address, so a check-in could not read it. Offer to set up a routine instead.",
            );
        }
        const existing = (await options.list(options.ownerUserId)).find(
          (setting) =>
            setting.agentId === options.agentId &&
            (link
              ? setting.sourceLink === link
              : setting.subject.toLowerCase() === subject.toLowerCase()),
        );
        // An older check-in on this page read every app instead; accepting this one makes it read the page.
        if (
          existing?.enabled &&
          !(existing.sourceKind === "apps" && source.kind === "page")
        )
          return `You already check ${subject} for them. The card says so; carry on.`;
        const reads =
          source.kind === "page"
            ? "that page"
            : `${source.title}, and nothing else`;
        return `A card in front of the person offers a daily check-in on ${subject}, reading ${reads}, with Turn on and Not now. Do not ask about it in words; carry on with your answer.`;
      },
    },
  ];
}
