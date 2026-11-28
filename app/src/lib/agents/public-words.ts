import type { AgentProfile } from "./queries";

/**
 * Who a public Bot reaches, said the same way on its Sharing page, its Visibility row, the New Bot
 * sheet and the Sharing summary.
 *
 * Public means everyone in this organization, never everyone on OpenBot: OpenBot Cloud gives each
 * person an organization of their own, and "everyone on OpenBot" read there as the whole world.
 * Where the person is the organization's only member, the words say it's only them.
 * Pure, so each sentence is pinned by a fast test.
 */
export type PublicAudience = {
  /** The organization's name, where the app knows it. */
  organizationName?: string;
  /** Whether the person is the organization's only member. Undefined while not known. */
  alone?: boolean;
};

/** "everyone in Acme", or "everyone in the organization" where the name isn't known. */
export function everyoneIn({ organizationName }: PublicAudience): string {
  return `everyone in ${organizationName?.trim() || "the organization"}`;
}

/** What the Visibility choice says a public Bot does. */
export function publicVisibilityWords(audience: PublicAudience): string {
  return audience.alone
    ? `${capitalised(everyoneIn(audience))} can find and use it. Right now that's only you.`
    : `${capitalised(everyoneIn(audience))} can find and use it.`;
}

/**
 * The Sharing page of a public Bot that isn't published: who can use it, as its heading, and one
 * line under it where the heading needs one. Never "not published" next to "public".
 */
export function publicSharingWords(audience: PublicAudience): {
  title: string;
  description: string | null;
} {
  if (audience.alone) {
    const where = audience.organizationName?.trim();
    return {
      title: "Only you can use it",
      description: where
        ? `It's public, and you're the only member of ${where}.`
        : "It's public, and you're the only member of the organization.",
    };
  }
  return {
    title: `${capitalised(everyoneIn(audience))} can use it`,
    description: "It's public.",
  };
}

/** The Sharing row's summary for a public Bot that isn't published. */
export function publicSharingSummary(audience: PublicAudience): string {
  return audience.alone
    ? "Only you (public)"
    : `${capitalised(everyoneIn(audience))} (public)`;
}

/**
 * Whether OpenBot itself provides this Bot: one that comes with OpenBot (`systemOwned`), or one of
 * the Bots an OpenBot starts with (`packageBotId`, which the server sets only on those and leaves
 * null on every Bot somebody made). Such a Bot is included with OpenBot, not shared by anybody.
 */
export function comesWithOpenBot(
  agent: Pick<AgentProfile, "systemOwned" | "packageBotId">,
): boolean {
  return agent.systemOwned || (agent.packageBotId ?? null) !== null;
}

function capitalised(words: string): string {
  return words.charAt(0).toUpperCase() + words.slice(1);
}
