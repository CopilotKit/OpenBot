import { useQuery } from "@tanstack/react-query";
import { BotOrb } from "@/components/agents/bot-orb";
import { Skeleton } from "@/components/ui/skeleton";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";

/**
 * The top of a conversation with one Bot: its orb, its name, what it does, and who can see it.
 *
 * Drawn from the Bot's profile, with visibility shown only in the team edition.
 * It is the first thing in the transcript's scroll content and scrolls away with it.
 *
 * The empty-state pattern sits behind the orb as a halo (`.orb-pattern` in styles.css), so it follows
 * the `--empty-pattern*` tokens and a skin that turns the pattern off turns this off too.
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
  const about = [agent.title, agent.roleDescription]
    .filter((part): part is string => Boolean(part?.trim()))
    .join(" · ");
  return (
    <div className="flex items-center gap-5 pt-4 pb-2">
      <div className="relative isolate grid shrink-0 place-items-center">
        <div aria-hidden className="orb-pattern" />
        <BotOrb
          name={agent.name}
          seed={agent.avatarSeed || agent.id}
          size={96}
        />
      </div>
      <div className="min-w-0">
        <h1 className="font-bold text-3xl tracking-tight">{agent.name}</h1>
        {/* Two lines at most: a role can run to a paragraph, and the intro introduces, it doesn't brief.
            The whole role is on the Bot's page and in the detail pane. */}
        {about ? (
          <p
            className="mt-1 line-clamp-2 max-w-[60ch] text-muted-foreground"
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
    <div aria-hidden className="flex items-center gap-5 pt-4 pb-2">
      <div className="relative isolate grid shrink-0 place-items-center">
        <div className="orb-pattern" />
        <Skeleton className="size-24 rounded-full" />
      </div>
      <div className="min-w-0 flex-1">
        {/* The heading's line, then two lines of role, as `line-clamp-2` allows. */}
        <div className="flex h-9 items-center">
          <Skeleton className="h-7 w-48" />
        </div>
        <div className="mt-1 flex h-12 max-w-[60ch] flex-col justify-around">
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
