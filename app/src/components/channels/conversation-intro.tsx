import { useQuery } from "@tanstack/react-query";
import { BotOrb } from "@/components/agents/bot-orb";
import { Skeleton } from "@/components/ui/skeleton";
import { shownSubtitle } from "@/lib/agents/subtitle";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";

/**
 * Figma's "Bot Card" at the top of a conversation: white, 20px corners, the 72px orb beside the
 * name in 32px and two lines of what the Bot does. Shared with the placeholder, which has to take
 * exactly its room.
 */
const CARD = "flex items-center gap-4 rounded-card bg-card p-5";

/**
 * The top of a conversation with one Bot: its orb, its name, what it does, and who can see it.
 *
 * Drawn from the Bot's profile, with visibility shown only in the team edition.
 * It is the first thing in the transcript's scroll content and scrolls away with it.
 *
 * A card, as Figma draws it, rather than words on the page: it is the Bot's card, the one Home
 * shows, at the size of a heading.
 */
export function ConversationIntro({
  agent,
}: {
  agent: {
    id: string;
    name: string;
    title?: string | null;
    roleDescription?: string | null;
    avatarSeed?: string | null;
    visibility: "public" | "private";
  };
}) {
  const personal =
    useQuery(deploymentCapabilitiesQueryOptions()).data?.edition === "personal";
  const about = [
    agent.title && shownSubtitle(agent.title),
    agent.roleDescription,
  ]
    .filter((part): part is string => Boolean(part?.trim()))
    .join(" · ");
  return (
    <div className={CARD}>
      <div className="grid shrink-0 place-items-center">
        <BotOrb
          name={agent.name}
          seed={agent.avatarSeed || agent.id}
          size={72}
        />
      </div>
      <div className="min-w-0">
        <h1 className="truncate font-semibold text-3xl tracking-heading">
          {agent.name}
        </h1>
        {/* Two lines at most: a role can run to a paragraph, and the intro introduces, it doesn't brief.
            The whole role is on the Bot's page and in the detail pane. */}
        {about ? (
          <p
            className="mt-2 line-clamp-2 text-muted-foreground text-sm"
            title={about}
          >
            {about}
          </p>
        ) : null}
        {personal ? null : (
          <div className="mt-3 flex flex-wrap gap-2">
            <span className="inline-flex h-6.5 items-center rounded-lg bg-muted px-2.5 font-semibold text-[13px] text-muted-foreground">
              {agent.visibility === "public" ? "Public" : "Private"}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Where the intro will be, while the Bot it introduces is still being picked.
 *
 * A message sent from home opens a conversation before a Bot is chosen (`/start/$startId`). The
 * conversation it becomes has this intro above the message, and lands scrolled to its end, so the
 * message sits where the end of the scroll puts it. Without something in the intro's place above
 * it, the placeholder had nothing to scroll and drew the message at the top, and the message
 * dropped 48px when the conversation arrived. The same footprint as `ConversationIntro`, line for
 * line, so the conversation that replaces it moves nothing but the orb and the words coming in.
 */
export function ConversationIntroPlaceholder() {
  const personal =
    useQuery(deploymentCapabilitiesQueryOptions()).data?.edition === "personal";
  return (
    <div aria-hidden className={CARD}>
      <div className="grid shrink-0 place-items-center">
        <Skeleton className="size-18 rounded-full" />
      </div>
      <div className="min-w-0 flex-1">
        {/* The heading's line, then two lines of role, as `line-clamp-2` allows. */}
        <div className="flex h-9 items-center">
          <Skeleton className="h-7 w-48" />
        </div>
        <div className="mt-2 flex h-[2lh] flex-col justify-around text-sm">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-2/3" />
        </div>
        {personal ? null : (
          <div className="mt-3 flex">
            <Skeleton className="h-6.5 w-16 rounded-lg" />
          </div>
        )}
      </div>
    </div>
  );
}
