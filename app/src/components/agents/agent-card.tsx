import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import type { AgentProfile } from "@/lib/agents/queries";

export function AgentCard({ agent }: { agent: AgentProfile }) {
  return (
    <div className="h-[180px] bg-foreground/10 rounded-2xl w-[144px] relative overflow-hidden">
      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
        <AbstractAvatar
          image={agent.avatarUrl}
          name={agent.name}
          seed={agent.avatarSeed}
          size={250}
        />
      </div>
      <div className="absolute top-0 left-0 w-full h-full bg-background/40 dark:bg-background/50" />
      <div className="absolute top-0 left-0 w-full h-full flex flex-col justify-end p-3 gap-2">
        <span className="text-sm font-medium line-clamp-1">{agent.name}</span>
        <span className="text-xs text-foreground dark:text-foreground/80 line-clamp-3">
          {agent.roleDescription}
        </span>
      </div>
    </div>
  );
}
