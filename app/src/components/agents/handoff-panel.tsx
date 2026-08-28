import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import { Switch } from "@/components/ui/switch";
import { setHandoffGrantMutationOptions } from "@/lib/agents/mutations";
import {
  agentHandoffQueryOptions,
  agentListQueryOptions,
} from "@/lib/agents/queries";

/**
 * Which Bots this one may hand work to.
 *
 * On the Bot's own screen rather than in the connector catalogue: a catalogue entry has a fixed list
 * of tools somebody else maintains, and the Bots a deployment has are whatever was made here. It is
 * also the question a person asks while looking at a Bot, not while looking at a vendor.
 *
 * DIRECTIONAL, and said so on the screen, because the pair is the one thing about this that is easy
 * to get backwards: this is who this Bot may ask, not who may ask it.
 */
export function HandoffPanel({ agentId }: { agentId: string }) {
  const queryClient = useQueryClient();
  const handoff = useQuery(agentHandoffQueryOptions(agentId));
  const agents = useQuery(agentListQueryOptions());
  const setGrant = useMutation(setHandoffGrantMutationOptions(queryClient));

  if (handoff.isPending || !handoff.data) return null;
  const { enabled, canGrant, reachable } = handoff.data;

  /*
   * A Bot may not be granted itself, and the server refuses it, so it is not offered here either.
   * Hidden Bots are already absent from this list.
   */
  const others = (agents.data ?? []).filter(
    (candidate) => candidate.id !== agentId,
  );

  // Nothing to say to somebody who cannot change it and has nothing to read.
  if (!canGrant && reachable.length === 0) return null;

  return (
    <section className="mt-6 grid gap-2">
      <h2 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
        Bots it may ask
      </h2>

      <p className="text-muted-foreground text-sm">
        {enabled
          ? "Work this Bot cannot do itself, it may hand to one of these. The Bot it asks answers in its own conversation, as itself."
          : "Handing work between Bots is switched off for this deployment, so none of these takes effect until it is switched back on."}
      </p>

      {setGrant.error ? (
        <p className="text-destructive text-sm" role="alert">
          {setGrant.error.message}
        </p>
      ) : null}

      {others.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          There is no other Bot here to hand work to.
        </p>
      ) : (
        <ul className="grid gap-1 rounded-lg border border-border bg-card p-1">
          {others.map((candidate) => {
            const held = reachable.includes(candidate.id);
            return (
              <li
                className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5"
                key={candidate.id}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <AbstractAvatar
                    name={candidate.name}
                    seed={candidate.avatarSeed}
                    size={24}
                  />
                  <span className="min-w-0">
                    <span className="block truncate text-sm">
                      {candidate.name}
                    </span>
                    <span className="block truncate text-muted-foreground text-xs">
                      {candidate.title}
                    </span>
                  </span>
                </span>
                <Switch
                  aria-label={`Let ${candidate.name} be asked by this Bot`}
                  checked={held}
                  disabled={!canGrant || setGrant.isPending}
                  onCheckedChange={(next: boolean) =>
                    setGrant.mutate({
                      agentId,
                      ref: candidate.id,
                      granted: next,
                    })
                  }
                />
              </li>
            );
          })}
        </ul>
      )}

      {canGrant ? null : (
        <p className="text-muted-foreground text-xs">
          An administrator decides which Bots may be asked.
        </p>
      )}
    </section>
  );
}
