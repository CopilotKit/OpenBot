import { IconArrowRight } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import { Button } from "@/components/ui/button";
import type { AgentProfile } from "@/lib/agents/queries";

export function AgentCard({
  agent,
  appearance = "compact",
}: {
  agent: AgentProfile;
  appearance?: "compact" | "tile";
}) {
  if (appearance === "tile") {
    return (
      <div className="flex h-[180px] w-[144px] flex-col overflow-hidden rounded-2xl border border-border bg-card p-3 transition-colors hover:border-ring dark:border-transparent">
        <div aria-hidden="true" className="flex shrink-0">
          <AbstractAvatar name={agent.name} seed={agent.avatarSeed} size={36} />
        </div>
        {/* Bottom-aligned, where the text sat on the earlier artwork card; the avatar holds the top. */}
        <div className="mt-auto flex min-w-0 flex-col gap-2">
          <span
            className="line-clamp-1 break-words text-sm font-medium leading-5"
            title={agent.name}
          >
            {agent.name}
          </span>
          <span className="line-clamp-3 break-words text-xs leading-4 text-muted-foreground">
            {agent.roleDescription}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex h-[160px] w-full min-w-0 flex-col gap-2 overflow-hidden rounded-2xl border border-border bg-card p-3 dark:border-transparent">
      <div aria-hidden="true" className="mb-1 flex shrink-0">
        <AbstractAvatar name={agent.name} seed={agent.avatarSeed} size={28} />
      </div>
      <div className="flex min-w-0 flex-col gap-2">
        <span
          className="line-clamp-1 break-words text-sm font-medium leading-5"
          title={agent.name}
        >
          {agent.name}
        </span>
        <span className="line-clamp-2 break-words text-xs leading-4 text-muted-foreground">
          {agent.roleDescription}
        </span>
      </div>
      <div className="mt-auto flex shrink-0 items-center justify-between pt-2">
        {/* Extend the details link across the card without nesting interactive elements. */}
        <Button
          variant="ghost"
          size="xs"
          aria-label={`View details for ${agent.name}`}
          className="-ml-2 text-muted-foreground after:absolute after:inset-0"
          render={<Link params={{ agentId: agent.id }} to="/bots/$agentId" />}
        >
          Details
        </Button>
        <IconArrowRight
          aria-hidden="true"
          className="size-4 text-muted-foreground"
          stroke={1.5}
        />
      </div>
    </div>
  );
}
