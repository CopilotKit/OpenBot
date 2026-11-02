import { BotOrb } from "@/components/agents/bot-orb";

/**
 * The top of a conversation with one Bot: its orb, its name, what it does, and who can see it.
 *
 * Drawn from the Bot's profile the conversation already holds, so it asks the server for nothing.
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
        <div className="mt-3 flex flex-wrap gap-2">
          <span className="inline-flex h-6.5 items-center rounded-lg bg-muted px-2.5 font-semibold text-[13px] text-muted-foreground">
            {agent.visibility === "public" ? "Public" : "Private"}
          </span>
        </div>
      </div>
    </div>
  );
}
