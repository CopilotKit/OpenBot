import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { ChannelAvatar } from "@/components/channels/avatar";
import { SidebarToggle } from "@/components/layout/sidebar-toggle";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { channelKeys } from "@/lib/channels/queries";
import { createGroupMutationOptions } from "@/lib/groups";

/**
 * Start a conversation with two or more Bots. It is an ordinary channel holding several Bots; the
 * server refuses any Bot this person cannot see, exactly as it does for a one-Bot channel.
 */
export const Route = createFileRoute("/_authed/_app/group/new")({
  component: RouteComponent,
});

function RouteComponent() {
  const navigate = Route.useNavigate();
  const queryClient = useQueryClient();
  const profiles = useQuery(agentListQueryOptions());
  const create = useMutation(createGroupMutationOptions(queryClient));
  const [chosen, setChosen] = useState<string[]>([]);

  const start = async () => {
    const channel = await create.mutateAsync(chosen);
    queryClient.setQueryData(channelKeys.detail(channel.id), channel);
    await navigate({
      to: "/group/$channelId",
      params: { channelId: channel.id },
      replace: true,
    });
  };

  return (
    <div className="flex h-full flex-col">
      <div className="sticky top-0 flex h-12 flex-row items-center gap-1.5 border-b border-border px-3">
        <SidebarToggle />
        <span className="text-sm tracking-tight">New group conversation</span>
      </div>
      <div className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 py-6">
        <p className="text-sm text-muted-foreground">
          Choose at least two Bots, in the order they should answer. Each sees
          what the others said and can hand the conversation to another with
          @Name.
        </p>
        {profiles.isError ? (
          <p className="text-sm text-destructive" role="alert">
            {profiles.error.message}
          </p>
        ) : null}
        <div className="flex flex-col gap-1">
          {(profiles.data ?? []).map((profile) => {
            const checked = chosen.includes(profile.id);
            return (
              <label
                className="flex h-10 cursor-pointer items-center gap-2 rounded-lg px-2 hover:bg-foreground/5"
                htmlFor={`group-bot-${profile.id}`}
                key={profile.id}
              >
                <Checkbox
                  aria-label={profile.name}
                  checked={checked}
                  id={`group-bot-${profile.id}`}
                  onCheckedChange={(next) =>
                    setChosen((current) =>
                      next
                        ? [...current, profile.id]
                        : current.filter((id) => id !== profile.id),
                    )
                  }
                />
                <ChannelAvatar participantIds={[profile.id]} size={24} />
                <span className="text-sm">{profile.name}</span>
                {checked ? (
                  <span className="text-xs text-muted-foreground">
                    answers {ordinal(chosen.indexOf(profile.id) + 1)}
                  </span>
                ) : null}
                <span className="truncate text-sm text-muted-foreground">
                  {profile.title}
                </span>
              </label>
            );
          })}
        </div>
        {create.error ? (
          <p className="text-sm text-destructive" role="alert">
            {create.error.message}
          </p>
        ) : null}
        <div>
          <Button
            disabled={chosen.length < 2 || create.isPending}
            onClick={() => void start().catch(() => {})}
          >
            Start group
          </Button>
        </div>
      </div>
    </div>
  );
}

function ordinal(position: number) {
  return ["first", "second", "third"][position - 1] ?? `#${position}`;
}
