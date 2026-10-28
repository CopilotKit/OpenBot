import { IconDots } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import { agentListQueryOptions } from "@/lib/agents/queries";

/**
 * OpenDots' coworker home: the Bot you are about to talk to, centred above an empty conversation.
 *
 * Drawn by the frame over OpenBot's own new-conversation page, which leaves that space empty. It
 * holds no state and sends nothing: the To: field and composer beneath are OpenBot's. The stylesheet
 * hides it the moment the page shows a message, so it never sits over a conversation.
 */
export function CoworkerPersona({ botId }: { botId: string }) {
  const agents = useQuery(agentListQueryOptions());
  const bot = agents.data?.find((agent) => agent.id === botId);
  if (!bot) return null;
  return (
    <div
      className="pointer-events-none absolute inset-x-0 top-[73px] z-[1] flex justify-center px-6 max-md:top-16"
      data-opendots-persona
    >
      <div className="flex max-w-[420px] flex-col items-center text-center">
        {/* OpenBot's own avatar for the Bot; the name below is its label. */}
        <span aria-hidden className="mb-2">
          <AbstractAvatar name={bot.name} seed={bot.avatarSeed} size={64} />
        </span>
        <h2 className="mb-1.5 text-[17px] font-[550] tracking-[-0.2px] text-foreground">
          {bot.name}
        </h2>
        {bot.roleDescription ? (
          <p className="mb-2 line-clamp-3 text-[13px] leading-[1.7] text-(--opendots-persona-ink)">
            {bot.roleDescription}
          </p>
        ) : null}
        <Link
          className="pointer-events-auto inline-flex items-center gap-[5px] rounded-md text-[12px] text-(--opendots-text-button) outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          params={{ agentId: bot.id }}
          to="/bots/$agentId"
        >
          Edit Bot <IconDots className="size-3.5" />
        </Link>
      </div>
    </div>
  );
}
