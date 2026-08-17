import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import { AgentFields } from "@/components/agents/agent-fields";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { agentInputFrom } from "@/lib/agents/form";
import {
  deleteAgentMutationOptions,
  duplicateAgentMutationOptions,
  setAgentHiddenMutationOptions,
  updateAgentMutationOptions,
} from "@/lib/agents/mutations";
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
      <div className="flex flex-col gap-2">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
      </div>
    </div>
  );
}

export function AgentProfile({ agentId }: { agentId: string }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  // State is keyed by teammate id because this panel can remain open while its target changes.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(
    null,
  );
  const isEditing = editingId === agentId;
  const isConfirmingDelete = confirmingDeleteId === agentId;

  const agent = useQuery(agentQueryOptions(agentId));
  const updateAgent = useMutation(updateAgentMutationOptions(queryClient));
  const duplicateAgent = useMutation(
    duplicateAgentMutationOptions(queryClient),
  );
  const setHidden = useMutation(setAgentHiddenMutationOptions(queryClient));
  const deleteAgent = useMutation(deleteAgentMutationOptions(queryClient));

  if (agent.isPending) {
    return <ProfileSkeleton />;
  }
  if (agent.error || !agent.data) {
    return (
      <p className="p-8 text-sm text-destructive" role="alert">
        Could not load this teammate.
      </p>
    );
  }

  const profile = agent.data;
  const actionError =
    duplicateAgent.error ?? setHidden.error ?? deleteAgent.error;

  return (
    <div className="flex w-full flex-col gap-6 p-8">
      <header className="flex flex-col items-center gap-3 text-center">
        <AbstractAvatar
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

      {isEditing ? (
        <AgentFields
          defaultValues={{
            name: profile.name,
            roleDescription: profile.roleDescription,
            title: profile.title,
            visibility: profile.visibility,
            endpoint: profile.endpoint ?? "",
            // The server never sends credentials back to the client.
            authValue: "",
          }}
          hasAuth={profile.hasAuth}
          error={updateAgent.error}
          onCancel={() => setEditingId(null)}
          onSubmit={async (values) => {
            await updateAgent.mutateAsync({
              agentId,
              input: agentInputFrom(values),
            });
            setEditingId(null);
          }}
          submitLabel="Save changes"
        />
      ) : (
        <section className="grid gap-2">
          <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Role
          </h2>
          <p className="text-sm whitespace-pre-wrap text-pretty">
            {profile.roleDescription}
          </p>
        </section>
      )}

      {actionError ? (
        <p className="text-sm text-destructive" role="alert">
          {actionError.message}
        </p>
      ) : null}

      {isEditing ? null : (
        <div className="flex flex-col gap-2 w-full mt-6">
          <Button
            className="w-full text-sm!"
            onClick={async () => {
              await navigate({
                search: { agent: agentId },
                to: "/channel/new",
              });
            }}
          >
            Start channel
          </Button>

          <Button
            className="w-full text-sm!"
            disabled={duplicateAgent.isPending}
            onClick={async () => {
              const copy = await duplicateAgent.mutateAsync(agentId);
              await navigate({ search: { agent: copy.id }, to: "/agents" });
            }}
            variant="outline"
          >
            {duplicateAgent.isPending ? "Duplicating…" : "Duplicate"}
          </Button>

          <Button
            className="w-full text-sm!"
            disabled={setHidden.isPending}
            onClick={async () => {
              await setHidden.mutateAsync({
                agentId,
                hidden: !profile.hidden,
              });
              if (!profile.hidden)
                await navigate({ search: {}, to: "/agents" });
            }}
            variant="outline"
          >
            {setHidden.isPending
              ? profile.hidden
                ? "Unhiding…"
                : "Hiding…"
              : profile.hidden
                ? "Unhide"
                : "Hide"}
          </Button>

          {profile.hidden ? (
            <p className="-mt-1 text-xs text-muted-foreground">
              Hidden from your agents list. This changes nothing for anyone
              else.
            </p>
          ) : null}

          {profile.canManage ? (
            <Button
              className="w-full text-sm!"
              onClick={() => setEditingId(agentId)}
              variant="outline"
            >
              Edit
            </Button>
          ) : null}

          {profile.canManage ? (
            <>
              <Separator className="my-1" />

              {isConfirmingDelete ? (
                <div className="flex flex-col gap-2">
                  <p className="text-sm">
                    Delete <span className="font-medium">{profile.name}</span>?
                    This cannot be undone.
                  </p>
                  {/* Cancel remains closest to the original Delete button position. */}
                  <Button
                    className="w-full text-sm!"
                    onClick={() => setConfirmingDeleteId(null)}
                    variant="outline"
                  >
                    Cancel
                  </Button>
                  <Button
                    className="w-full text-sm!"
                    disabled={deleteAgent.isPending}
                    onClick={async () => {
                      await deleteAgent.mutateAsync(agentId);
                      await navigate({ search: {}, to: "/agents" });
                    }}
                    variant="destructive"
                  >
                    {deleteAgent.isPending ? "Deleting…" : "Delete"}
                  </Button>
                </div>
              ) : (
                <Button
                  className="w-full text-sm!"
                  onClick={() => setConfirmingDeleteId(agentId)}
                  variant="destructive"
                >
                  Delete
                </Button>
              )}
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}
