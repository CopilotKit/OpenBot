import { OFFER_CHECK_IN_TOOL } from "@openbot/shared/check-in-offer";
import type { GrantedTool } from "@openbot/toolkit/granted-tool";
import { z } from "zod";
import type { ProactiveSetting } from "./types";

/**
 * The tool every Bot holds for offering the person a check-in on one thing.
 *
 * ASKED, NEVER ASSUMED. Check-ins used to switch themselves on the first time a person talked to a
 * Bot, and then read everything it could reach every hour: a person who never asked found their
 * Bots list full of things it had decided were theirs. Now a Bot offers one, about the one thing
 * the two of them just looked at, and nothing runs until the person accepts on the card.
 *
 * A READ, AND ONLY EVER ONE. This writes nothing. It answers whether there is anything to offer
 * (check-ins allowed, not already watching it), and the card in front of the person does the rest:
 * Turn on creates the check-in as them, through the same route the Bot's check-ins page uses.
 */
export function checkInOfferTools(options: {
  ownerUserId: string;
  agentId: string;
  /** Whether this person may have check-ins at all (an admin can turn them off). */
  allowed(ownerUserId: string): Promise<boolean>;
  /** This person's check-ins, to tell an offer from one already running. */
  list(ownerUserId: string): Promise<ProactiveSetting[]>;
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
        .describe("The page's web address, when it has one."),
    })
    .strict();
  return [
    {
      name: OFFER_CHECK_IN_TOOL,
      ref: `check-ins/${OFFER_CHECK_IN_TOOL}`,
      description: [
        "Offer the person a daily check-in on one thing you just looked at together: you read it once a day and tell them only when something there needs them.",
        "Offer it after you read something that keeps changing and that they care about over time: a document being worked on, a project page, their inbox, a channel. Not for a one-off lookup, such as a fact read off a page.",
        "Offer at most once per thing in a conversation, and never again once they said no. The card asks them; do not ask in words as well.",
      ].join(" "),
      parameters,
      async execute(args) {
        const parsed = parameters.safeParse(args);
        if (!parsed.success) return "Say what the check-in would watch.";
        const { subject, link } = parsed.data;
        if (!(await options.allowed(options.ownerUserId)))
          return "Check-ins are turned off for this person, so there is nothing to offer. Do not offer again.";
        const existing = (await options.list(options.ownerUserId)).find(
          (setting) =>
            setting.agentId === options.agentId &&
            (link
              ? setting.sourceLink === link
              : setting.subject.toLowerCase() === subject.toLowerCase()),
        );
        if (existing?.enabled)
          return `You already check ${subject} for them. The card says so; carry on.`;
        return `A card in front of the person offers a daily check-in on ${subject}, with Turn on and Not now. Do not ask about it in words; carry on with your answer.`;
      },
    },
  ];
}
