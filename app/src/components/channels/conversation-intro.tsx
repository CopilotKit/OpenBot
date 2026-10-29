import { BotOrb } from "@/components/agents/bot-orb";

/**
 * The top of a conversation with one Bot: its orb, its name, what it does, and who can see it.
 *
 * Drawn from the Bot's profile the conversation already holds, so it asks the server for nothing.
 * It is the first thing in the transcript's scroll content and scrolls away with it.
 *
 * The CopilotKit dot matrix sits behind the orb, faded out at its edge, at `--accent-dot-opacity`.
 * Those tokens exist only in the default skin, which is the only place this is drawn.
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
      <div className="relative isolate grid shrink-0 place-items-center before:pointer-events-none before:absolute before:-inset-10 before:-z-10 before:bg-(image:--dot-tile) before:opacity-(--accent-dot-opacity) before:content-[''] before:[mask-image:radial-gradient(circle,#000_30%,rgb(0_0_0/0.35)_55%,transparent_72%)]">
        <BotOrb
          name={agent.name}
          seed={agent.avatarSeed || agent.id}
          size={96}
        />
      </div>
      <div className="min-w-0">
        <h1 className="font-bold text-3xl tracking-tight">{agent.name}</h1>
        {about ? <p className="mt-1 text-muted-foreground">{about}</p> : null}
        <div className="mt-3 flex flex-wrap gap-2">
          <span className="inline-flex h-6.5 items-center rounded-lg bg-muted px-2.5 font-semibold text-[13px] text-muted-foreground">
            {agent.visibility === "public" ? "Public" : "Private"}
          </span>
        </div>
      </div>
    </div>
  );
}
