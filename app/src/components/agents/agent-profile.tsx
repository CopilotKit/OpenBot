import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import { AgentDialog } from "@/components/agents/agent-dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { agentQueryOptions } from "@/lib/agents/queries";

function Tag({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full border border-border bg-muted/40 px-2 py-0.5 text-xs text-muted-foreground">
      {children}
    </span>
  );
}

function ProfileSkeleton() {
  return (
    <div className="flex w-full flex-col gap-6 p-8">
      <header className="flex flex-col items-center gap-3">
        <Skeleton className="size-20 shrink-0 rounded-full" />
        <div className="flex w-full flex-col items-center gap-1.5">
          <Skeleton className="h-7 w-44" />
          <Skeleton className="h-4 w-28" />
        </div>
        <div className="flex gap-1.5">
          <Skeleton className="h-5 w-16 rounded-full" />
          <Skeleton className="h-5 w-24 rounded-full" />
        </div>
      </header>
      <div className="grid gap-2">
        <Skeleton className="h-3 w-10" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-2/3" />
      </div>
      <Skeleton className="h-9 w-full" />
    </div>
  );
}

/**
 * Who this coworker is, beside a conversation with it.
 *
 * A card, not a control panel: the panel answers "who am I talking to" — avatar, name, role — and
 * everything that changes the coworker lives in its own dialog, opened from the one button here.
 * It used to duplicate that dialog's whole surface (edit form, tokens, grants, delete), which made
 * two places to maintain and a sidebar that scrolled past the conversation it sat beside.
 */
export function AgentProfile({ agentId }: { agentId: string }) {
  /** The full dialog, opened over the chat rather than navigating away from it. */
  const [managing, setManaging] = useState(false);
  const navigate = useNavigate();
  const agent = useQuery(agentQueryOptions(agentId));

  if (agent.isPending) {
    return <ProfileSkeleton />;
  }
  if (agent.error || !agent.data) {
    return (
      <p className="p-8 text-sm text-destructive" role="alert">
        Could not load this coworker.
      </p>
    );
  }

  const profile = agent.data;

  return (
    <div className="flex w-full flex-col gap-6 p-8">
      <header className="flex flex-col items-center gap-3 text-center">
        <AbstractAvatar
          image={profile.avatarUrl}
          name={profile.name}
          seed={profile.avatarSeed}
          size={80}
        />
        <div className="flex w-full flex-col items-center gap-0.5">
          <h1 className="w-full text-balance text-2xl font-semibold leading-tight tracking-tight">
            {profile.name}
          </h1>
          <p className="w-full text-balance text-sm text-muted-foreground">
            {profile.title}
          </p>
        </div>

        <div className="flex flex-wrap justify-center gap-1.5">
          <Tag>{profile.visibility === "private" ? "Private" : "Public"}</Tag>
          {profile.systemOwned ? <Tag>System owned</Tag> : null}
        </div>
      </header>

      <section className="grid gap-2">
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Role
        </h2>
        <p className="text-sm whitespace-pre-wrap text-pretty">
          {profile.roleDescription}
        </p>
      </section>

      <div className="flex flex-col gap-2">
        <Button
          className="w-full text-sm!"
          onClick={() =>
            void navigate({ search: { agent: agentId }, to: "/channel/new" })
          }
        >
          Start new channel
        </Button>
        <Button
          className="w-full text-sm!"
          onClick={() => setManaging(true)}
          variant="outline"
        >
          Manage coworker
        </Button>
      </div>

      <AgentDialog
        agentId={agentId}
        onClose={() => setManaging(false)}
        open={managing}
      />
    </div>
  );
}
