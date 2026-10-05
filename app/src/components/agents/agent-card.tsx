import { IconArrowRight } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import Avatar from "boring-avatars";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import { Button } from "@/components/ui/button";
import type { AgentProfile } from "@/lib/agents/queries";

export function AgentCard({
  agent,
  appearance = "compact",
}: {
  agent: AgentProfile;
  appearance?: "compact" | "artwork";
}) {
  if (appearance === "artwork") {
    return (
      <div className="relative h-[180px] w-[144px] overflow-hidden rounded-2xl bg-foreground/10">
        <div
          aria-hidden="true"
          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
        >
          <Avatar name={agent.avatarSeed} size={250} />
        </div>
        <div className="absolute top-0 left-0 h-full w-full bg-background/40 dark:bg-background/50" />
        <div className="absolute top-0 left-0 flex h-full w-full flex-col justify-end gap-2 p-3">
          <span className="line-clamp-1 text-sm font-medium">{agent.name}</span>
          <span className="line-clamp-3 text-xs text-foreground dark:text-foreground/80">
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
          render={<Link to="/agents" search={{ agent: agent.id }} />}
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
